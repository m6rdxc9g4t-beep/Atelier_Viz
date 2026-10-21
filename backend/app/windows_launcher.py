"""Lanceur de l'application de bureau sous Windows (raccourci « Atelier Viz » du menu Démarrer).

Créé par `scripts/windows/build_app.ps1`, le raccourci lance, depuis `backend/` :
    pythonw.exe -X utf8 -m app.windows_launcher

Équivalent du lanceur de `Atelier Viz.app` (scripts/macos/build_app.sh) :
- `PATH` complété de celui figé à l'installation (`%LOCALAPPDATA%\\Atelier Viz\\launcher.json`) : la CLI
  `claude`, `node` / `npm` ou les DLL d'un environnement conda restent trouvables ;
- journal `%LOCALAPPDATA%\\Atelier Viz\\Logs\\atelier-viz.log` (limité à 5 Mo, l'ancien gardé une fois) —
  `pythonw` n'a pas de console : sans cela, tout message serait perdu ;
- interface plus ancienne que ses sources : `npm run build` (hors ligne). **Jamais de `npm install`** au
  lancement : si les dépendances ont changé, message « relancez build_app.ps1 » (`app/launcher.py`) ;
- modules Python manquants : boîte de message, pas de fenêtre vide ;
- puis `app.desktop.run()` : serveur local et fenêtre WebView2.

`--self-test` : mêmes vérifications, démarrage du serveur, contrôle de `/api/health` et de l'interface,
arrêt — sans fenêtre (intégration continue, diagnostic). Bibliothèque standard jusqu'au lancement.
"""

from __future__ import annotations

import contextlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import time
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import IO, Any

from app.launcher import APP_NAME, LOG_NAME, build_script, interface_action, log_dir

ROOT = Path(__file__).resolve().parents[2]
FRONTEND = ROOT / "frontend"
LOG_LIMIT_BYTES = 5_000_000
REQUIRED_MODULES = ("fastapi", "uvicorn", "duckdb", "webview")
CREATE_NO_WINDOW = 0x08000000
NPM_BUILD_TIMEOUT_SECONDS = 600.0

Alert = Callable[[str], None]


def config_path(environ: Mapping[str, str] | None = None) -> Path:
    """`%LOCALAPPDATA%\\Atelier Viz\\launcher.json` : réglages figés par build_app.ps1."""
    env = os.environ if environ is None else environ
    base = env.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
    return Path(base) / APP_NAME / "launcher.json"


def read_config(path: Path) -> dict[str, Any]:
    """Réglages du lanceur ; {} si absents ou illisibles (le lanceur fonctionne sans)."""
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def merged_path(current: str, saved: str, sep: str = os.pathsep) -> str:
    """`PATH` actuel complété des entrées absolues du `PATH` figé à l'installation, sans doublon.

    Les entrées enregistrées passent en tête (comme le lanceur macOS, qui reprend le `PATH` du terminal) ;
    la comparaison ignore la casse et la barre oblique finale (Windows).
    """
    seen: set[str] = set()
    out: list[str] = []
    for entry in [*saved.split(sep), *current.split(sep)]:
        entry = entry.strip().strip('"')
        key = entry.rstrip("\\/").lower()
        if not entry or key in seen or not os.path.isabs(entry):
            continue
        seen.add(key)
        out.append(entry)
    return sep.join(out)


def rotate_log(path: Path, limit: int = LOG_LIMIT_BYTES) -> None:
    """Journal au-delà de `limit` octets : renommé en `.1` (l'ancien `.1` est remplacé)."""
    with contextlib.suppress(OSError):
        if path.stat().st_size > limit:
            os.replace(path, path.with_name(path.name + ".1"))


def open_log(environ: Mapping[str, str] | None = None) -> tuple[Path, IO[str]]:
    """Ouvre le journal en ajout (UTF-8, ligne par ligne) après rotation."""
    folder = log_dir("win32", environ)
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / LOG_NAME
    rotate_log(path)
    return path, open(path, "a", encoding="utf-8", buffering=1)  # noqa: SIM115 — gardé ouvert jusqu'à la fin


def message_box(text: str) -> None:
    """Boîte de message Windows (erreur), sinon sur la sortie d'erreur."""
    if sys.platform == "win32":
        with contextlib.suppress(Exception):
            import ctypes

            ctypes.windll.user32.MessageBoxW(None, text, APP_NAME, 0x10 | 0x40000)  # type: ignore[attr-defined]
            return
    print(text, file=sys.stderr)


WEBVIEW2_CLIENTS = (
    "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",  # Runtime « Evergreen »
    "{2CD8A007-E189-409D-A2C8-9AF4EF3C72AA}",  # Beta
    "{0D50BFEC-CD6A-4F9A-964C-C7416E3ACB10}",  # Dev
    "{65C35B14-6C1D-4122-AC46-7148CC9D6497}",  # Canary
)
WEBVIEW2_URL = "https://developer.microsoft.com/microsoft-edge/webview2/"


def webview2_version() -> str | None:
    """Version du moteur WebView2 (Edge) installé, ou None (même recherche que pywebview).

    Sans WebView2, pywebview se rabattrait sur l'ancien moteur d'Internet Explorer, incapable d'afficher
    l'interface : on l'annonce plutôt que d'ouvrir une fenêtre blanche.
    """
    try:
        import winreg  # type: ignore[import-not-found,unused-ignore]
    except ImportError:
        return None
    roots = [
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients"),
        (winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\EdgeUpdate\Clients"),
        (winreg.HKEY_CURRENT_USER, r"SOFTWARE\Microsoft\EdgeUpdate\Clients"),
    ]
    for hive, base in roots:
        for client in WEBVIEW2_CLIENTS:
            try:
                with winreg.OpenKey(hive, f"{base}\\{client}") as key:
                    version, _ = winreg.QueryValueEx(key, "pv")
            except OSError:
                continue
            if isinstance(version, str) and version and version != "0.0.0.0":
                return version
    return None


def missing_modules(names: Sequence[str] = REQUIRED_MODULES) -> list[str]:
    """Modules Python requis absents de cet interpréteur."""
    return [name for name in names if importlib.util.find_spec(name) is None]


def update_interface(
    front: Path,
    log: IO[str],
    alert: Alert,
    *,
    run: Callable[..., subprocess.CompletedProcess[Any]] = subprocess.run,
    which: Callable[[str], str | None] = shutil.which,
) -> str:
    """Recompile l'interface si elle est périmée ; renvoie l'action décidée (`ok` / `build` / `install`).

    Jamais d'installation de paquets : `install` affiche seulement un message (si une interface existe).
    """
    action = interface_action(front)
    stamp = time.strftime("%Y-%m-%d %H:%M:%S")
    if action == "build":
        print(f"--- {stamp} : interface plus ancienne que ses sources, recompilation (npm run build)", file=log)
        npm = which("npm")
        if npm is None:
            alert(
                "L'interface n'est plus à jour et npm est introuvable. L'ancienne interface est utilisée ; "
                f"relancez {build_script('win32')}."
            )
            return action
        try:
            done = run(  # noqa: S603 — npm trouvé dans le PATH, arguments fixes
                [npm, "run", "build", "--silent"],
                cwd=str(front),
                stdout=log,
                stderr=log,
                timeout=NPM_BUILD_TIMEOUT_SECONDS,
                creationflags=CREATE_NO_WINDOW,
                check=False,
            )
            ok = done.returncode == 0
        except (OSError, subprocess.SubprocessError) as exc:
            print(f"npm run build : {exc}", file=log)
            ok = False
        if not ok:
            alert(
                "La mise à jour de l'interface a échoué (voir le journal). L'ancienne interface est utilisée ; "
                f"relancez {build_script('win32')}."
            )
    elif action == "install":
        print(f"--- {stamp} : dépendances de l'interface absentes ou modifiées : rien n'est installé", file=log)
        if (front / "dist" / "index.html").is_file():
            alert(
                "Les dépendances de l'interface ont changé (mise à jour du code). Relancez "
                f"{build_script('win32')} pour les installer ; en attendant, l'ancienne interface est utilisée."
            )
    return action


def self_test(log: IO[str]) -> int:
    """Démarre le serveur sans fenêtre, vérifie l'API et l'interface, puis l'arrête (0 = tout va bien)."""
    import webview  # type: ignore[import-not-found]  # noqa: F401 — pywebview et son pont .NET s'importent

    from app.core.config import get_settings
    from app.desktop import prepare, probe, serves_interface

    url, server, error = prepare(get_settings())
    try:
        if error:
            print(f"Échec : {error}", file=log)
            return 1
        health = probe(url, timeout=5)
        page = serves_interface(url, timeout=5)
        state = f"API {'ok' if health else 'muette'}, interface {'ok' if page else 'absente'}"
        print(f"Auto-test : {url} — {state}", file=log)
        return 0 if health and page else 1
    finally:
        if server is not None:
            server.stop()


def main(argv: Sequence[str] | None = None) -> int:
    """Point d'entrée du raccourci Windows."""
    args = list(sys.argv[1:] if argv is None else argv)
    testing = "--self-test" in args
    if testing:
        args.remove("--self-test")

    config = read_config(config_path())
    saved = config.get("path")
    if isinstance(saved, str) and saved:
        os.environ["PATH"] = merged_path(os.environ.get("PATH", ""), saved)

    log_path, log = open_log()
    # pythonw n'a ni console ni sorties : tout part dans le journal.
    sys.stdout = log
    sys.stderr = log
    alert: Alert = print if testing else message_box  # type: ignore[assignment]
    print(f"--- {time.strftime('%Y-%m-%d %H:%M:%S')} : lancement ({sys.executable})", file=log)

    update_interface(FRONTEND, log, alert)
    missing = missing_modules()
    if missing:
        alert(f"Des modules Python manquent ({', '.join(missing)}) dans {sys.executable}. "
              f"Relancez {build_script('win32')}.")  # fmt: skip
        return 1
    if testing:
        print(f"WebView2 : {webview2_version() or 'absent'}", file=log)
    elif sys.platform == "win32" and "--browser" not in args and webview2_version() is None:
        alert(
            "Le moteur Microsoft Edge WebView2 est introuvable : la fenêtre ne peut pas s'afficher. "
            f"Installez « WebView2 Runtime » ({WEBVIEW2_URL}), puis relancez {APP_NAME}."
        )
        return 1
    try:
        if testing:
            return self_test(log)
        from app.desktop import run

        return run(args)
    except Exception as exc:  # noqa: BLE001 — dernier recours : expliquer plutôt que disparaître
        import traceback

        traceback.print_exc(file=log)
        alert(f"{APP_NAME} s'est arrêté : {exc}\n\nJournal : {log_path}")
        return 1
    finally:
        with contextlib.suppress(Exception):
            log.flush()


if __name__ == "__main__":
    raise SystemExit(main())
