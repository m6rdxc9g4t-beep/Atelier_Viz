"""Ouvrir une autre application de la Suite Atelier depuis l'app de bureau (docs/SUITE.md §3 et §9.4).

- **Environnement propre** : l'app ouverte ne reçoit **aucune** variable de Viz (`DATA_DIR`, `PORT`, `PYTHON*`,
  `ATELIER_*`…), seulement une liste blanche (utilisateur, dossier personnel, langue, fuseau, dossiers temporaires et
  système) et le `PATH` du système (`minimal_env`).
- macOS : `open -b <identifiant>` (inchangé).
- Windows (§9.6) : le lanceur de l'app est lu dans `HKCU\\Software\\Atelier\\Apps\\<viz|tab|projets|nexus>`
  (valeur `Lanceur` : raccourci `.lnk` du menu Démarrer) et ouvert **toujours** par le shell :
  `explorer.exe "<Lanceur>"`, lancé avec l'environnement minimal ; l'Explorateur démarre l'app avec son propre
  environnement de session. Jamais d'exécution directe du chemin, quelle que soit son extension. Absent ou
  introuvable : l'appelant ouvre l'adresse de l'app dans le navigateur par défaut.

Bibliothèque standard seulement.
"""

from __future__ import annotations

import os
import subprocess
import sys
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

from app import launcher

REGISTRY_ROOT = r"Software\Atelier\Apps"
"""Clé (sous HKEY_CURRENT_USER) où chaque app de la suite installée sous Windows s'enregistre (§9.4)."""

WINDOWS_APP_IDS = {
    "fr.atelier-viz.app": "viz",
    "fr.atelier.tab": "tab",
    "local.atelier-projets.desktop": "projets",
}
"""Identifiant de l'app macOS → nom de l'app dans le registre Windows (Atelier Cuisine n'en a pas : navigateur)."""

ENV_WHITELIST = frozenset(
    {
        # docs/SUITE.md §9.6 : liste complète (noms comparés sans tenir compte de la casse), plus `LC_*` et `PATH`.
        "HOME",
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "USER",
        "USERNAME",
        "USERDOMAIN",
        "LOGNAME",
        "LANG",
        "TZ",
        "TMPDIR",
        "TEMP",
        "TMP",
        "SYSTEMROOT",
        "SYSTEMDRIVE",
        "WINDIR",
        "COMSPEC",
        "PATHEXT",
        "APPDATA",
        "LOCALAPPDATA",
        "PROGRAMDATA",
        "PROGRAMFILES",
        "PROGRAMFILES(X86)",
        "PROGRAMW6432",
    }
)
"""Variables transmises à l'app ouverte, plus `LC_*` et `PATH` (celui du système)."""

POSIX_SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"


def system_path(platform: str | None = None, registry: Callable[[], str | None] = launcher.registry_path) -> str:
    """`PATH` du système, sans les ajouts de Viz ni d'aucune autre app.

    Windows : `PATH` de la session lu dans le registre (système puis utilisateur), sinon les dossiers de Windows.
    """
    platform = platform or sys.platform
    if platform != "win32":
        return POSIX_SYSTEM_PATH
    path = registry()
    if path:
        return path
    root = os.environ.get("SystemRoot") or r"C:\Windows"
    return ";".join([rf"{root}\System32", root, rf"{root}\System32\Wbem", rf"{root}\System32\WindowsPowerShell\v1.0"])


def minimal_env(
    source: Mapping[str, str] | None = None,
    platform: str | None = None,
    registry: Callable[[], str | None] = launcher.registry_path,
) -> dict[str, str]:
    """Environnement transmis à une autre app de la suite : liste blanche + `PATH` du système (§9.4)."""
    source = os.environ if source is None else source
    env = {key: value for key, value in source.items() if key.upper() in ENV_WHITELIST or key.upper().startswith("LC_")}
    env["PATH"] = system_path(platform, registry)
    return env


# --- macOS ------------------------------------------------------------------------------------------


def open_macos_app(
    bundle_id: str,
    run: Callable[..., subprocess.CompletedProcess[bytes]] = subprocess.run,
    platform: str | None = None,
) -> bool:
    """Ouvre une application installée par son identifiant (`open -b`) ; False si absente ou hors macOS."""
    if (platform or sys.platform) != "darwin":
        return False
    try:
        done = run(
            ["/usr/bin/open", "-b", bundle_id],
            capture_output=True,
            timeout=10,
            env=minimal_env(platform="darwin"),
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return done.returncode == 0


# --- Windows ----------------------------------------------------------------------------------------


def valid_launcher(value: object, exists: Callable[[Path], bool] = Path.is_file) -> Path | None:
    """Chemin de lanceur lu dans le registre s'il est utilisable : absolu (Windows) et existant."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip().strip('"')
    if not launcher.is_absolute_path(text, "win32"):
        return None
    path = Path(text)
    return path if exists(path) else None


def registry_launcher(app_id: str, root: str = REGISTRY_ROOT) -> Path | None:
    """Lanceur d'une app de la suite enregistré sous Windows (`HKCU\\<root>\\<app_id>`, valeur `Lanceur`), ou None."""
    if sys.platform != "win32":
        return None
    import winreg

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, rf"{root}\{app_id}") as key:
            value, kind = winreg.QueryValueEx(key, "Lanceur")
    except OSError:
        return None
    if kind == winreg.REG_EXPAND_SZ and isinstance(value, str):
        value = winreg.ExpandEnvironmentStrings(value)
    return valid_launcher(value)


def explorer_path(env: Mapping[str, str] | None = None) -> str:
    """`explorer.exe` du système (`%SystemRoot%\\explorer.exe`)."""
    env = os.environ if env is None else env
    root = next((v for k, v in env.items() if k.upper() == "SYSTEMROOT" and v), r"C:\Windows")
    return str(Path(root) / "explorer.exe")


def _spawn(cmd: Sequence[str], *, env: Mapping[str, str]) -> Any:
    return subprocess.Popen(  # noqa: S603 — explorer.exe du système, chemin du lanceur en argument, sans shell
        list(cmd),
        env=dict(env),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
        creationflags=launcher.CREATE_NO_WINDOW | launcher.CREATE_NEW_PROCESS_GROUP,
    )


def open_windows_app(
    app_id: str,
    *,
    read: Callable[[str], Path | None] = registry_launcher,
    spawn: Callable[..., Any] = _spawn,
    env: Mapping[str, str] | None = None,
) -> bool:
    """Ouvre le lanceur enregistré d'une app de la suite par `explorer.exe "<Lanceur>"` (§9.6) ; False si aucun.

    `explorer.exe` est lancé avec l'environnement minimal ; il délègue l'ouverture à l'Explorateur de la session,
    qui démarre l'app avec son propre environnement. Le chemin est un argument (jamais une ligne interprétée).
    """
    target = read(app_id)
    if target is None:
        return False
    clean = minimal_env() if env is None else dict(env)
    try:
        spawn([explorer_path(clean), str(target)], env=clean)
    except OSError:
        return False
    return True


# --- Toutes plateformes -------------------------------------------------------------------------------


def open_suite_app(bundle_id: str, platform: str | None = None) -> bool:
    """Ouvre l'app de bureau d'une autre app de la suite si elle est installée ; False sinon (→ navigateur)."""
    platform = platform or sys.platform
    if platform == "darwin":
        return open_macos_app(bundle_id)
    if platform == "win32":
        app_id = WINDOWS_APP_IDS.get(bundle_id)
        return bool(app_id) and open_windows_app(app_id)  # type: ignore[arg-type]
    return False
