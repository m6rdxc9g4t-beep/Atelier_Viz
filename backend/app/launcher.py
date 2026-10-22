"""Mise à jour automatique de l'application de bureau après un `git pull` (docs/SUITE.md §8 et §9).

Décision de l'utilisateur : après un `git pull`, l'application de bureau (« Atelier Viz.app » sur macOS, raccourci
« Atelier Viz » du menu Démarrer sous Windows) se met à jour toute seule à son lancement suivant, comme Atelier
Projets (`desktop/lib/prepare.cjs`). Le code exécuté est celui du dépôt ; ce module décide et fait, **seulement si
nécessaire** et dans cet ordre :

- `pip`   : `pip install -r requirements.txt [-r requirements-desktop.txt]` avec **le Python de l'application**,
            si ces fichiers (ou l'interpréteur) ont changé depuis la dernière mise à jour réussie ;
- `npm`   : `npm ci` (depuis `frontend/package-lock.json`), si le lockfile a changé ou si `node_modules` manque ;
- `build` : `npm run build` dans un dossier temporaire (`frontend/.dist-next`) puis remplacement de
            `frontend/dist` : la compilation précédente reste servie en cas d'échec.

La décision compare l'**état du dépôt** (empreinte de `HEAD` et du contenu des fichiers modifiés localement ou
nouveaux non ignorés, `git status --porcelain`, §8.4) et les empreintes des fichiers de dépendances au **tampon**
de la dernière mise à jour réussie (`backend/.mise-a-jour.json`, ignoré par git), écrit seulement après une mise
à jour entièrement réussie. Une seule mise à jour à la fois (verrou `backend/.mise-a-jour.lock`). Jamais de
`git pull`, jamais de donnée touchée (`backend/data/` n'est ni lu ni écrit, sauf la lecture du mode en ligne).
Réseau : seulement les registres de paquets (npm, PyPI), pendant les étapes d'installation.

Sous-processus : commandes fixes (aucune donnée en argument), délai borné puis arrêt du groupe (Windows :
`taskkill /T`), jamais de fenêtre de console (Windows : `CREATE_NO_WINDOW`), sortie dans le journal
`mise-a-jour.log` de `logs_dir()` (taille bornée) : `~/Library/Logs/Atelier Viz/` (macOS),
`%LOCALAPPDATA%\\Atelier Viz\\Logs\\` (Windows, §9.2). Node / npm sont cherchés même depuis le Finder ou le menu
Démarrer : `PATH`, puis macOS : `PATH` du shell de connexion zsh, `~/.homebrew/bin`, `/opt/homebrew/bin`,
`/usr/local/bin`, nvm, Volta ; Windows (§9.3) : `PATH` de l'utilisateur et du système lu dans le registre,
`%ProgramFiles%\\nodejs`, nvm-windows (`%NVM_SYMLINK%`), Volta, fnm, Scoop, `%LOCALAPPDATA%\\Programs\\nodejs`
(`node.exe …\\node_modules\\npm\\bin\\npm-cli.js`, sans shell, avec des arguments fixes : §9.6).

Au lancement de l'application de bureau, `scrub_inherited_env` retire les variables héritées d'une autre app qui
tromperaient Viz (docs/SUITE.md §9.4 : `DATA_DIR`, `NODE_ENV`, `PYTHONPATH`…) : sa configuration vient de
`backend/.env`.

Bibliothèque standard seulement : fonctionne même si des dépendances Python manquent (c'est l'étape `pip` qui
les installe). Le paquet autonome (PyInstaller) ne l'utilise jamais.

Ligne de commande (depuis `backend/`) :
    python -m app.launcher --mettre-a-jour [--depot DOSSIER]   # mise à jour en console (build_app.sh, install.ps1)
    python -m app.launcher --plan [--depot DOSSIER]            # étapes nécessaires, sans rien faire
    python -m app.launcher <dossier frontend>                  # anciens lanceurs : « ok » (desktop.py fait la suite)
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable, Collection, Iterator, Mapping, MutableMapping, Sequence
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import IO, Any, Literal, Protocol

Step = Literal["pip", "npm", "build"]

ROOT = Path(__file__).resolve().parents[2]
"""Racine du dépôt (le code exécuté par l'application de bureau)."""

STAMP_NAME = ".mise-a-jour.json"
LOCK_NAME = ".mise-a-jour.lock"
LOG_NAME = "mise-a-jour.log"
NEXT_DIST = ".dist-next"
OLD_DIST = ".dist-old"

PY_REQUIREMENTS = ("requirements.txt", "requirements-desktop.txt")
"""Dépendances Python installées dans l'environnement de l'application (dans cet ordre, si présentes)."""

LABELS: dict[Step, str] = {
    "pip": "Installation des dépendances Python (pip install)…",
    "npm": "Installation des dépendances de l'interface (npm ci)…",
    "build": "Compilation de l'interface…",
}
TIMEOUTS: dict[Step, float] = {"pip": 20 * 60.0, "npm": 20 * 60.0, "build": 10 * 60.0}
"""Délai maximal de chaque étape, en secondes (puis arrêt du groupe de processus)."""

INSTALL_STEPS: frozenset[Step] = frozenset({"pip", "npm"})
"""Étapes qui utilisent le réseau (registres de paquets)."""

MAX_LOG_BYTES = 20_000_000
"""Taille maximale écrite dans le journal par une étape (au-delà : processus arrêté)."""
ROTATE_LOG_BYTES = 5_000_000
"""Au-delà, le journal est renommé `mise-a-jour.log.1` au début de la mise à jour suivante."""

APP_NAME = "Atelier Viz"
LOGIN_SHELL = "/bin/zsh"
SYSTEM_BIN_DIRS = ("/opt/homebrew/bin", "/usr/local/bin")
"""Emplacements habituels de Node sur macOS (Homebrew Apple Silicon, Intel / installateur nodejs.org)."""
_PATH_MARK = "__ATELIER_PATH__"

WINDOWS = sys.platform == "win32"
CREATE_NO_WINDOW = 0x08000000
CREATE_NEW_PROCESS_GROUP = 0x00000200
REPLACE_ATTEMPTS = 20
"""Windows : essais de renommage d'un dossier dont un fichier est encore ouvert (0,5 s entre deux essais)."""


def _spawn_options() -> dict[str, Any]:
    """Options de `Popen` : groupe de processus à part (arrêt des enfants), jamais de console sous Windows."""
    if WINDOWS:
        return {"creationflags": CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP}
    return {"start_new_session": True}


# --- Empreintes et état du dépôt ------------------------------------------------------------------


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def file_digest(path: Path) -> str:
    """Empreinte du contenu d'un fichier (« absent » s'il n'existe pas)."""
    try:
        return _digest(path.read_bytes())
    except OSError:
        return "absent"


def _capture(cmd: Sequence[str], *, timeout: float, cwd: Path | None = None, limit: int = 1_000_000) -> str | None:
    """Sortie standard d'une commande courte (bornée en temps et en taille), ou None en cas d'échec."""
    with tempfile.TemporaryFile() as out:
        try:
            proc = subprocess.Popen(  # noqa: S603 — commande fixe, exécutable absolu
                list(cmd),
                stdin=subprocess.DEVNULL,
                stdout=out,
                stderr=subprocess.DEVNULL,
                cwd=cwd,
                **_spawn_options(),
            )
        except OSError:
            return None
        try:
            code = proc.wait(timeout)
        except subprocess.TimeoutExpired:
            _stop_group(proc)
            return None
        if code != 0:
            return None
        out.seek(0)
        return out.read(limit).decode("utf-8", "replace")


def git_search_dirs(env: Mapping[str, str], platform: str | None = None) -> list[str]:
    """Dossiers où chercher `git` : PATH filtré, puis emplacements habituels du système."""
    platform = platform or sys.platform
    dirs = safe_path_dirs(env.get("PATH", ""), platform)
    if platform == "win32":
        extra = [
            *(str(Path(env[k]) / "Git" / "cmd") for k in ("ProgramFiles", "ProgramW6432") if env.get(k)),
            *([str(Path(env["LOCALAPPDATA"]) / "Programs" / "Git" / "cmd")] if env.get("LOCALAPPDATA") else []),
        ]
    else:
        extra = ["/usr/bin", "/opt/homebrew/bin", "/usr/local/bin"]
    return dirs + [d for d in extra if d not in dirs]


def find_git(path: str | None = None) -> str | None:
    """Exécutable `git` absolu (PATH filtré, puis emplacements habituels)."""
    env = {**os.environ, "PATH": path} if path is not None else os.environ
    found = shutil.which("git", path=os.pathsep.join(git_search_dirs(env)))
    return str(Path(found).resolve()) if found and Path(found).is_absolute() else None


def changed_paths(porcelain: str) -> list[str]:
    """Chemins de `git status --porcelain -z` : modifiés, supprimés, nouveaux non ignorés (docs/SUITE.md §8.4).

    Un renommage donne deux entrées (« XY nouveau », puis l'ancien chemin seul) : les deux comptent.
    """
    paths: list[str] = []
    entries = porcelain.split("\0")
    i = 0
    while i < len(entries):
        entry = entries[i]
        i += 1
        if len(entry) < 4:
            continue
        paths.append(entry[3:])
        if entry[0] in "RC" and i < len(entries) and entries[i]:
            paths.append(entries[i])
            i += 1
    return sorted(set(paths))


def code_state(repo: Path, git: str | None) -> str:
    """Empreinte du code : commit courant + contenu des fichiers modifiés localement (docs/SUITE.md §8.1, §8.4).

    Compte les fichiers suivis modifiés **et** les fichiers nouveaux non ignorés par git. Sans git (ou hors d'un
    dépôt git) : « sans-git » (seules les dépendances et l'interface compilée comptent).
    """
    if git is None:
        return "sans-git"
    head = _capture([git, "-C", str(repo), "rev-parse", "HEAD"], timeout=20)
    if head is None:
        return "sans-git"
    listing = _capture(
        [git, "-C", str(repo), "status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], timeout=30
    )
    changed = changed_paths(listing or "")
    parts = [head.strip()]
    for name in changed:
        target = repo / name
        parts.append(f"{name}:{file_digest(target) if target.is_file() else 'supprimé'}")
    return _digest("\n".join(parts).encode("utf-8"))


def requirement_files(repo: Path) -> list[Path]:
    """Fichiers de dépendances Python installés par l'étape `pip` (ceux qui existent)."""
    backend = repo / "backend"
    return [backend / name for name in PY_REQUIREMENTS if (backend / name).is_file()]


@dataclass(frozen=True)
class RepoState:
    """État comparé au tampon : code, dépendances de l'interface, dépendances Python et interpréteur."""

    code: str
    npm: str
    pip: str
    python: str


def repo_state(repo: Path, python: str, git: str | None) -> RepoState:
    """État actuel du dépôt (voir `RepoState`)."""
    pip = _digest("\n".join(f"{p.name}:{file_digest(p)}" for p in requirement_files(repo)).encode("utf-8"))
    return RepoState(
        code=code_state(repo, git),
        npm=file_digest(repo / "frontend" / "package-lock.json"),
        pip=pip,
        python=python,
    )


# --- node_modules conforme au lockfile (dépôts antérieurs au tampon) -------------------------------


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def dependencies_current(front: Path) -> bool:
    """Vrai si `node_modules` correspond à `package-lock.json` (et celui-ci à `package.json`).

    Compare chaque paquet du verrou à `node_modules/.package-lock.json` (écrit par npm à l'installation) :
    même version. Un paquet facultatif absent est normal (binaires d'autres plateformes). Sert quand il n'y a
    pas encore de tampon (première mise à jour) : évite un `npm ci` inutile.
    """
    lock = _read_json(front / "package-lock.json")
    installed = _read_json(front / "node_modules" / ".package-lock.json")
    manifest = _read_json(front / "package.json")
    if lock is None or installed is None or manifest is None:
        return False
    wanted = lock.get("packages")
    present = installed.get("packages")
    if not isinstance(wanted, dict) or not isinstance(present, dict):
        return False
    root = wanted.get("", {})
    for key in ("dependencies", "devDependencies", "optionalDependencies"):
        if (manifest.get(key) or {}) != (root.get(key) or {}):
            return False  # package.json modifié sans `npm install`
    for name, entry in wanted.items():
        if not name or not isinstance(entry, dict):
            continue
        have = present.get(name)
        if have is None:
            if entry.get("optional") or entry.get("devOptional"):
                continue
            return False
        if not isinstance(have, dict) or have.get("version") != entry.get("version"):
            return False
    return True


# --- Tampon et plan --------------------------------------------------------------------------------


def read_stamp(path: Path) -> RepoState | None:
    """Tampon de la dernière mise à jour réussie, ou None (absent, illisible)."""
    data = _read_json(path)
    if data is None:
        return None
    try:
        return RepoState(**{k: str(data[k]) for k in ("code", "npm", "pip", "python")})
    except KeyError:
        return None


def write_stamp(path: Path, state: RepoState) -> None:
    """Écrit le tampon (atomique)."""
    tmp = path.with_name(f"{path.name}.tmp")
    payload = {**asdict(state), "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
    tmp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def forget_stamp(repo: Path = ROOT) -> None:
    """Oublie la dernière mise à jour réussie : le lancement suivant refait tout ce qui manque (pip compris).

    Appelé quand l'application ne trouve pas ses modules Python (environnement recréé ou abîmé).
    """
    with contextlib.suppress(OSError):
        (repo / "backend" / STAMP_NAME).unlink()


def plan_steps(repo: Path, state: RepoState, stamp: RepoState | None) -> tuple[Step, ...]:
    """Étapes nécessaires (vide : tout est à jour), dans l'ordre d'exécution."""
    front = repo / "frontend"
    steps: list[Step] = []
    if stamp is None or stamp.pip != state.pip or stamp.python != state.python:
        steps.append("pip")
    modules = front / "node_modules" / ".package-lock.json"
    if not modules.is_file() or (stamp.npm != state.npm if stamp else not dependencies_current(front)):
        steps.append("npm")
    built = (front / "dist" / "index.html").is_file()
    if "npm" in steps or stamp is None or stamp.code != state.code or not built:
        steps.append("build")
    return tuple(steps)


@dataclass(frozen=True)
class Plan:
    """État du dépôt et étapes nécessaires."""

    state: RepoState
    steps: tuple[Step, ...]


@dataclass(frozen=True)
class UpdateResult:
    """Résultat d'une mise à jour.

    `previous_available` : une interface compilée existe (l'application peut s'ouvrir avec elle) ;
    `network` : l'échec vient d'une étape d'installation (registres de paquets).
    """

    ok: bool
    steps: tuple[Step, ...] = ()
    failed_step: Step | None = None
    message: str | None = None
    previous_available: bool = False
    busy: bool = False
    log: str = ""

    @property
    def network(self) -> bool:
        return self.failed_step in INSTALL_STEPS


# --- Recherche de Node / npm ---------------------------------------------------------------------


def safe_path_dirs(path: str, platform: str | None = None) -> list[str]:
    """Entrées d'un PATH utilisables : absolues, sans `node_modules/.bin` (jamais un binaire d'un projet).

    Séparateur et forme absolue selon `platform` (Windows : « ; », `C:\\…` ou `\\\\serveur\\…`).
    """
    windows = (platform or sys.platform) == "win32"
    sep = ";" if windows else ":"
    dirs: list[str] = []
    for raw in path.split(sep):
        entry = raw.strip().strip('"') if windows else raw
        if not entry or not is_absolute_path(entry, "win32" if windows else "posix"):
            continue
        if "node_modules" in re.split(r"[\\/]" if windows else "/", entry):
            continue
        if entry not in dirs:
            dirs.append(entry)
    return dirs


def is_absolute_path(entry: str, platform: str | None = None) -> bool:
    """Chemin absolu selon `platform` (Windows : `C:\\…` ou `\\\\serveur\\…`, jamais `\\dossier` ni relatif)."""
    if (platform or sys.platform) == "win32":
        return bool(re.match(r"^[A-Za-z]:[\\/]", entry) or entry.startswith("\\\\"))
    return entry.startswith("/")


def registry_path() -> str | None:
    """Windows : PATH du système puis de l'utilisateur lus dans le registre (variables développées), ou None.

    Équivalent du shell de connexion de macOS : une application lancée depuis le menu Démarrer garde le PATH de
    l'ouverture de session ; Node installé depuis ne s'y trouve pas encore.
    """
    if not WINDOWS:
        return None
    import winreg

    parts: list[str] = []
    for hive, key in (
        (winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
        (winreg.HKEY_CURRENT_USER, "Environment"),
    ):
        try:
            with winreg.OpenKey(hive, key) as handle:
                value, _ = winreg.QueryValueEx(handle, "Path")
        except OSError:
            continue
        if isinstance(value, str) and value:
            parts.append(winreg.ExpandEnvironmentStrings(value))
    return ";".join(parts) or None


def system_login_path() -> str | None:
    """PATH « de connexion » selon le système : registre sous Windows, shell zsh de connexion ailleurs."""
    return registry_path() if WINDOWS else login_shell_path()


def login_shell_path(shell: str = LOGIN_SHELL, timeout: float = 8.0) -> str | None:
    """PATH du shell de connexion interactif de l'utilisateur (zsh), ou None.

    Une application lancée depuis le Finder n'hérite pas du PATH du terminal (Homebrew, nvm…).
    """
    if not Path(shell).is_file():
        return None
    out = _capture([shell, "-l", "-i", "-c", f'printf "{_PATH_MARK}%s{_PATH_MARK}" "$PATH"'], timeout=timeout)
    if out is None:
        return None
    match = re.search(f"{_PATH_MARK}(.*?){_PATH_MARK}", out, re.S)
    return match.group(1).strip() if match else None


def _version_key(name: str) -> tuple[int, ...]:
    return tuple(int(n) for n in re.findall(r"\d+", name)[:3])


def nvm_dirs(home: Path, env: Mapping[str, str]) -> list[str]:
    """Dossiers `bin` des versions de Node installées par nvm : version par défaut d'abord, puis la plus récente."""
    root = Path(env.get("NVM_DIR") or home / ".nvm")
    versions = root / "versions" / "node"
    if not versions.is_dir():
        return []
    installed = sorted((p for p in versions.iterdir() if (p / "bin").is_dir()), key=lambda p: _version_key(p.name))
    installed.reverse()
    try:
        alias = (root / "alias" / "default").read_text(encoding="utf-8").strip().lstrip("v")
    except OSError:
        alias = ""
    if re.fullmatch(r"\d+(\.\d+){0,2}", alias):
        preferred = [p for p in installed if p.name.lstrip("v") == alias or p.name.lstrip("v").startswith(alias + ".")]
        installed = preferred + [p for p in installed if p not in preferred]
    return [str(p / "bin") for p in installed]


def windows_node_dirs(env: Mapping[str, str], home: Path) -> list[str]:
    """Windows (docs/SUITE.md §9.3) : emplacements habituels de Node hors du PATH, dans l'ordre."""

    def under(var: str, *parts: str) -> list[str]:
        base = env.get(var)
        return [str(Path(base, *parts))] if base else []

    fnm = [str(Path(env["FNM_DIR"]) / "aliases" / "default")] if env.get("FNM_DIR") else []
    return [
        *under("ProgramFiles", "nodejs"),
        *under("ProgramW6432", "nodejs"),
        *under("NVM_SYMLINK"),
        *under("VOLTA_HOME", "bin"),
        *volta_node_dirs(env),
        *fnm,
        *under("APPDATA", "fnm", "aliases", "default"),
        *under("LOCALAPPDATA", "fnm", "aliases", "default"),
        *under("LOCALAPPDATA", "Programs", "nodejs"),
        str(home / "scoop" / "apps" / "nodejs-lts" / "current"),
        str(home / "scoop" / "apps" / "nodejs" / "current"),
        *under("ProgramFiles(x86)", "nodejs"),
    ]


def volta_node_dirs(env: Mapping[str, str]) -> list[str]:
    """Windows : versions de Node installées par Volta (les raccourcis de `Volta\\bin` n'ont pas `npm-cli.js`)."""
    base = env.get("VOLTA_HOME") or (str(Path(env["LOCALAPPDATA"]) / "Volta") if env.get("LOCALAPPDATA") else "")
    images = Path(base) / "tools" / "image" / "node" if base else None
    if images is None or not images.is_dir():
        return []
    versions = sorted((d for d in images.iterdir() if d.is_dir()), key=lambda d: _version_key(d.name), reverse=True)
    return [str(d) for d in versions]


WINDOWS_NPM_CLI = ("node_modules", "npm", "bin", "npm-cli.js")
"""Windows : script de npm à côté de `node.exe`, lancé par `node.exe` (docs/SUITE.md §9.6, jamais `npm.cmd`)."""


def npm_search_dirs(
    env: Mapping[str, str],
    home: Path,
    login_path: Callable[[], str | None] = system_login_path,
    platform: str | None = None,
) -> list[str]:
    """Dossiers où chercher Node et npm, dans l'ordre (voir le module)."""
    platform = platform or sys.platform
    dirs = safe_path_dirs(env.get("PATH", ""), platform)
    if platform == "win32":
        extras = [*safe_path_dirs(login_path() or "", platform), *windows_node_dirs(env, home)]
    else:
        extras = [
            *safe_path_dirs(login_path() or "", platform),
            str(home / ".homebrew" / "bin"),
            *SYSTEM_BIN_DIRS,
            *nvm_dirs(home, env),
            str(home / ".volta" / "bin"),
        ]
    for extra in extras:
        if extra not in dirs:
            dirs.append(extra)
    return dirs


def find_npm(
    env: Mapping[str, str] | None = None,
    home: Path | None = None,
    login_path: Callable[[], str | None] = system_login_path,
    platform: str | None = None,
) -> Path | None:
    """`npm` absolu dont le dossier contient aussi `node` (npm est un script `node`), ou None.

    Windows (docs/SUITE.md §9.6) : `…\\node_modules\\npm\\bin\\npm-cli.js` d'un dossier qui contient `node.exe` ;
    il est lancé par `node.exe` (`npm_command`), jamais par `npm.cmd` ni un shell.
    """
    env = os.environ if env is None else env
    platform = platform or sys.platform
    for folder in npm_search_dirs(env, home or Path.home(), login_path, platform):
        base = Path(folder)
        if platform == "win32":
            cli = base.joinpath(*WINDOWS_NPM_CLI)
            if cli.is_file() and (base / "node.exe").is_file():
                return cli
            continue
        npm, node = base / "npm", base / "node"
        if npm.is_file() and os.access(npm, os.X_OK) and node.is_file() and os.access(node, os.X_OK):
            return npm
    return None


def npm_command(npm: Path) -> list[str]:
    """Début de la commande npm : `[node.exe, npm-cli.js]` (Windows, sans shell), sinon `[npm]`."""
    if npm.name == "npm-cli.js":
        return [str(npm.parents[3] / "node.exe"), str(npm)]
    return [str(npm)]


def node_dir(npm: Path) -> Path:
    """Dossier de `node` pour une commande npm (mis en tête du PATH de npm et de ses scripts)."""
    return npm.parents[3] if npm.name == "npm-cli.js" else npm.parent


def find_node(
    env: Mapping[str, str] | None = None,
    home: Path | None = None,
    login_path: Callable[[], str | None] = system_login_path,
    platform: str | None = None,
) -> Path | None:
    """Exécutable `node` absolu (`node.exe` sous Windows), cherché comme npm ; None s'il est introuvable."""
    env = os.environ if env is None else env
    platform = platform or sys.platform
    name = "node.exe" if platform == "win32" else "node"
    for folder in npm_search_dirs(env, home or Path.home(), login_path, platform):
        node = Path(folder) / name
        if node.is_file() and (platform == "win32" or os.access(node, os.X_OK)):
            return node
    return None


def app_python(executable: str, platform: str | None = None) -> str:
    """Interpréteur de l'application : sous Windows, `python.exe` à la place de `pythonw.exe` (même environnement).

    Le raccourci lance `pythonw.exe` (sans console) ; `install.ps1` et le tampon utilisent `python.exe` : sans cette
    correspondance, le premier lancement réinstallerait les dépendances Python pour rien.
    """
    if (platform or sys.platform) != "win32":
        return executable
    path = Path(executable)
    if path.name.lower() == "pythonw.exe":
        console = path.with_name("python.exe")
        if console.is_file():
            path = console
    # Casse et séparateurs uniformes (C:\ ou c:\, / ou \) : le tampon compare des chaînes.
    return os.path.normcase(str(path)) if os.name == "nt" else str(path)


# --- Exécution bornée et journalisée ---------------------------------------------------------------


def _stop_group(proc: subprocess.Popen[bytes], grace: float = 5.0) -> None:
    """SIGTERM au groupe du processus (enfants compris), puis SIGKILL après `grace` secondes.

    Windows : `taskkill /T /F` arrête l'arbre des processus (node → esbuild…).
    """
    if WINDOWS:
        _taskkill(proc.pid)
        with contextlib.suppress(OSError):
            proc.kill()
        with contextlib.suppress(subprocess.TimeoutExpired):
            proc.wait(grace)
        return

    def send(sig: int) -> None:
        if os.name == "posix":
            with contextlib.suppress(OSError):
                os.killpg(proc.pid, sig)
                return
        with contextlib.suppress(OSError):
            proc.kill() if sig == getattr(signal, "SIGKILL", None) else proc.terminate()

    send(signal.SIGTERM)
    try:
        proc.wait(grace)
    except subprocess.TimeoutExpired:
        send(getattr(signal, "SIGKILL", signal.SIGTERM))
        with contextlib.suppress(subprocess.TimeoutExpired):
            proc.wait(grace)


def _taskkill(pid: int) -> None:
    root = os.environ.get("SystemRoot") or r"C:\Windows"
    with contextlib.suppress(OSError, subprocess.SubprocessError):
        subprocess.run(  # noqa: S603 — exécutable système, identifiant de processus entier
            [str(Path(root) / "System32" / "taskkill.exe"), "/PID", str(int(pid)), "/T", "/F"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=30,
            creationflags=CREATE_NO_WINDOW,
        )


class Runner(Protocol):
    def __call__(self, cmd: Sequence[str], *, cwd: Path, env: Mapping[str, str], log: Path, timeout: float) -> int: ...


def run_logged(
    cmd: Sequence[str],
    *,
    cwd: Path,
    env: Mapping[str, str],
    log: Path,
    timeout: float,
    max_log: int = MAX_LOG_BYTES,
    poll: float = 0.2,
) -> int:
    """Lance une commande fixe, sortie ajoutée au journal ; code de sortie (-1 : délai dépassé ou sortie trop longue).

    Le processus a son propre groupe (POSIX) : ses enfants (node, compilateurs) sont arrêtés avec lui.
    """
    log.parent.mkdir(parents=True, exist_ok=True)
    with open(log, "ab") as sink:
        sink.write(f"\n--- {time.strftime('%F %T')} $ {' '.join(cmd)}  (dans {cwd})\n".encode())
        sink.flush()
        start = sink.tell()
        try:
            proc = subprocess.Popen(  # noqa: S603 — commande fixe, exécutable absolu
                list(cmd),
                cwd=cwd,
                env=dict(env),
                stdin=subprocess.DEVNULL,
                stdout=sink,
                stderr=subprocess.STDOUT,
                **_spawn_options(),
            )
        except OSError as exc:
            sink.write(f"Lancement impossible : {exc}\n".encode())
            return -1
        deadline = time.monotonic() + timeout
        while True:
            try:
                code = proc.wait(poll)
                break
            except subprocess.TimeoutExpired:
                pass
            too_long = os.fstat(sink.fileno()).st_size - start > max_log
            if time.monotonic() > deadline or too_long:
                _stop_group(proc)
                reason = "sortie trop longue" if too_long else f"délai de {int(timeout)} s dépassé"
                sink.write(f"\nArrêté : {reason}.\n".encode())
                return -1
        sink.write(f"--- code de sortie {code}\n".encode())
        return code


def logs_dir(platform: str | None = None, home: Path | None = None, env: Mapping[str, str] | None = None) -> Path:
    """Dossier des journaux de l'application de bureau, selon le système (docs/SUITE.md §9.2).

    macOS `~/Library/Logs/Atelier Viz/` ; Windows `%LOCALAPPDATA%\\Atelier Viz\\Logs\\` ;
    Linux `$XDG_STATE_HOME/atelier-viz/` (`~/.local/state/atelier-viz/`).
    """
    platform = platform or sys.platform
    home = home or Path.home()
    env = os.environ if env is None else env
    if platform == "darwin":
        return home / "Library" / "Logs" / APP_NAME
    if platform == "win32":
        return Path(env.get("LOCALAPPDATA") or home / "AppData" / "Local") / APP_NAME / "Logs"
    return Path(env.get("XDG_STATE_HOME") or home / ".local" / "state") / "atelier-viz"


def log_path(platform: str | None = None, home: Path | None = None, env: Mapping[str, str] | None = None) -> Path:
    """Journal de la mise à jour : `mise-a-jour.log` dans `logs_dir()`."""
    return logs_dir(platform, home, env) / LOG_NAME


def _rotate(log: Path) -> None:
    with contextlib.suppress(OSError):
        if log.stat().st_size > ROTATE_LOG_BYTES:
            os.replace(log, log.with_name(log.name + ".1"))


# --- Verrou ----------------------------------------------------------------------------------------


@contextlib.contextmanager
def update_lock(path: Path, timeout: float, on_wait: Callable[[], None] = lambda: None) -> Iterator[bool]:
    """Verrou exclusif entre processus ; donne False si un autre le garde encore après `timeout` secondes."""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle: IO[str] = open(path, "a+", encoding="utf-8")  # noqa: SIM115 — fermé dans finally
    try:
        deadline = time.monotonic() + timeout
        waited = False
        while not _try_lock(handle):
            if not waited:
                on_wait()
                waited = True
            if time.monotonic() >= deadline:
                yield False
                return
            time.sleep(0.2)
        try:
            yield True
        finally:
            _unlock(handle)
    finally:
        handle.close()


def _try_lock(handle: IO[str]) -> bool:
    try:
        if os.name == "posix":
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        else:  # pragma: no cover — Windows
            import msvcrt

            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)  # type: ignore[attr-defined]
    except OSError:
        return False
    return True


def _unlock(handle: IO[str]) -> None:
    with contextlib.suppress(OSError):
        if os.name == "posix":
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        else:  # pragma: no cover — Windows
            import msvcrt

            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)  # type: ignore[attr-defined]


# --- Mise à jour -----------------------------------------------------------------------------------

StatusCallback = Callable[[str, int, int], None]
"""(libellé de l'étape, numéro à partir de 1, nombre d'étapes) ; numéro 0 : attente du verrou."""


class _StepFailed(Exception):
    pass


@dataclass
class Updater:
    """Mise à jour du dépôt `repo` pour l'interpréteur `python` (voir le module).

    Injectables pour les tests : `runner` (exécution des commandes), `npm_finder`, `git`, `log`, `env`.
    """

    repo: Path = ROOT
    python: str = field(default_factory=lambda: app_python(sys.executable))
    log: Path = field(default_factory=log_path)
    runner: Runner = run_logged
    npm_finder: Callable[[], Path | None] = find_npm
    git: str | None = field(default_factory=find_git)
    env: Mapping[str, str] = field(default_factory=lambda: dict(os.environ))
    lock_timeout: float = 30 * 60.0
    done: set[Step] = field(default_factory=set)
    """Étapes déjà faites par ce processus (Windows : `pip` avant l'ouverture de la fenêtre)."""

    @property
    def front(self) -> Path:
        return self.repo / "frontend"

    @property
    def stamp_path(self) -> Path:
        return self.repo / "backend" / STAMP_NAME

    @property
    def lock_path(self) -> Path:
        return self.repo / "backend" / LOCK_NAME

    def previous_available(self) -> bool:
        """Vrai si une interface compilée existe déjà (l'application peut s'ouvrir avec elle)."""
        return (self.front / "dist" / "index.html").is_file()

    def plan(self) -> Plan:
        """État du dépôt et étapes nécessaires (rien n'est exécuté)."""
        state = repo_state(self.repo, self.python, self.git)
        return Plan(state, plan_steps(self.repo, state, read_stamp(self.stamp_path)))

    def run(
        self, on_status: StatusCallback = lambda label, index, total: None, *, only: Collection[Step] | None = None
    ) -> UpdateResult:
        """Exécute les étapes nécessaires sous verrou ; le tampon n'est écrit qu'après un succès complet.

        `only` : seulement ces étapes (si nécessaires), sans écrire le tampon ; une étape ainsi réussie n'est pas
        refaite par l'appel complet suivant du même `Updater` (`done`, vidé après chaque appel complet).
        """
        try:
            return self._run(on_status, only)
        finally:
            if only is None:
                self.done.clear()

    def _run(self, on_status: StatusCallback, only: Collection[Step] | None) -> UpdateResult:
        _rotate(self.log)
        waiting = "Une autre mise à jour d'Atelier Viz est en cours, patientez…"
        with update_lock(self.lock_path, self.lock_timeout, lambda: on_status(waiting, 0, 0)) as acquired:
            if not acquired:
                return UpdateResult(
                    ok=False,
                    busy=True,
                    message="Une autre mise à jour d'Atelier Viz est en cours. Patientez, puis relancez l'application.",
                    previous_available=self.previous_available(),
                    log=str(self.log),
                )
            planned = self.plan().steps  # relu sous verrou : une autre instance a peut-être tout fait
            steps = tuple(s for s in planned if s not in self.done and (only is None or s in only))
            if steps:
                self._note(f"mise à jour : {', '.join(steps)} (dépôt {self.repo}, Python {self.python})")
            for index, step in enumerate(steps, start=1):
                on_status(LABELS[step], index, len(steps))
                try:
                    self._run_step(step)
                except _StepFailed as exc:
                    self._note(f"échec de l'étape {step} : {exc}")
                    return UpdateResult(
                        ok=False,
                        steps=steps,
                        failed_step=step,
                        message=str(exc),
                        previous_available=self.previous_available(),
                        log=str(self.log),
                    )
                self.done.add(step)
            if planned and only is None:
                write_stamp(self.stamp_path, repo_state(self.repo, self.python, self.git))
                self._note("mise à jour réussie")
            return UpdateResult(ok=True, steps=steps, previous_available=True, log=str(self.log))

    # Étapes ------------------------------------------------------------------------------------------

    def _note(self, text: str) -> None:
        with contextlib.suppress(OSError):
            self.log.parent.mkdir(parents=True, exist_ok=True)
            with open(self.log, "a", encoding="utf-8") as f:
                f.write(f"--- {time.strftime('%F %T')} : {text}\n")

    def _exec(self, step: Step, cmd: Sequence[str], cwd: Path, env: Mapping[str, str], what: str) -> None:
        code = self.runner(cmd, cwd=cwd, env=env, log=self.log, timeout=TIMEOUTS[step])
        if code == -1:
            minutes = max(1, round(TIMEOUTS[step] / 60))
            raise _StepFailed(f"{what} n'a pas abouti (délai de {minutes} min dépassé ou sortie trop longue).")
        if code != 0:
            hint = " Vérifiez la connexion au réseau." if step in INSTALL_STEPS else ""
            raise _StepFailed(f"{what} a échoué (code {code}).{hint}")

    def _base_env(self) -> dict[str, str]:
        env = dict(self.env)
        env.update(
            {
                "PIP_DISABLE_PIP_VERSION_CHECK": "1",
                "PIP_NO_INPUT": "1",
                "npm_config_update_notifier": "false",
                "npm_config_fund": "false",
                "npm_config_audit": "false",
            }
        )
        return env

    def _npm(self) -> tuple[Path, dict[str, str]]:
        npm = self.npm_finder()
        if npm is None:
            how = "« winget install OpenJS.NodeJS.LTS »" if WINDOWS else "« brew install node »"
            raise _StepFailed(
                f"Node.js (npm) est introuvable. Installez Node.js (https://nodejs.org ou {how}), "
                "puis relancez l'application."
            )
        env = self._base_env()
        # Dossier de node en tête : `npm` est un script `#!/usr/bin/env node` ; ses scripts (`vite`…) aussi.
        env["PATH"] = os.pathsep.join([str(node_dir(npm)), *safe_path_dirs(env.get("PATH", ""))])
        return npm, env

    def _run_step(self, step: Step) -> None:
        if step == "pip":
            requirements = requirement_files(self.repo)
            cmd = [self.python, "-m", "pip", "install", "--disable-pip-version-check", "--no-input"]
            for req in requirements:
                cmd += ["-r", req.name]
            self._exec(step, cmd, self.repo / "backend", self._base_env(), "L'installation des dépendances Python")
        elif step == "npm":
            npm, env = self._npm()
            cmd = [*npm_command(npm), "ci", "--no-audit", "--no-fund", "--loglevel=error"]
            self._exec(step, cmd, self.front, env, "L'installation des dépendances de l'interface (npm ci)")
        else:
            self._build()

    def _build(self) -> None:
        """`npm run build` dans `frontend/.dist-next`, puis remplacement de `frontend/dist` (gardé en cas d'échec)."""
        npm, env = self._npm()
        nxt, old, dist = self.front / NEXT_DIST, self.front / OLD_DIST, self.front / "dist"
        for leftover in (nxt, *self.front.glob(f"{OLD_DIST}*")):
            remove_tree(leftover)
        # Le script `build` se termine par `vite build` : les options suivantes lui reviennent (chemin relatif).
        cmd = [*npm_command(npm), "run", "build", "--", "--outDir", NEXT_DIST, "--emptyOutDir"]
        try:
            self._exec("build", cmd, self.front, env, "La compilation de l'interface")
            if not (nxt / "index.html").is_file():
                raise _StepFailed("La compilation de l'interface n'a pas produit index.html.")
            try:
                replace_dir(nxt, dist, old)
            except OSError as exc:
                self._note(f"remplacement de frontend/dist impossible : {exc}")
                raise _StepFailed(
                    "L'interface compilée n'a pas pu remplacer la précédente (fichiers utilisés par un autre "
                    "programme : une autre fenêtre d'Atelier Viz ?). Fermez-le : la mise à jour sera terminée au "
                    "prochain lancement."
                ) from exc
        except _StepFailed:
            remove_tree(nxt)
            raise


def _retrying(action: Callable[[], None], attempts: int, delay: float) -> None:
    """Réessaie une opération refusée par Windows parce qu'un fichier est ouvert (PermissionError)."""
    for attempt in range(1, max(1, attempts) + 1):
        try:
            action()
            return
        except PermissionError:
            if attempt >= attempts:
                raise
            time.sleep(delay)


def remove_tree(path: Path) -> None:
    """Supprime un dossier sans lever d'erreur (Windows : fichiers en lecture seule rendus inscriptibles)."""

    def writable(func: Callable[..., Any], target: str, _exc: object) -> None:
        with contextlib.suppress(OSError):
            os.chmod(target, stat.S_IWRITE)
            func(target)

    if not path.exists():
        return
    if sys.version_info >= (3, 12):
        shutil.rmtree(path, onexc=writable)
    else:  # pragma: no cover — Python 3.11
        shutil.rmtree(path, onerror=writable)


def replace_dir(new: Path, target: Path, aside: Path, *, attempts: int = REPLACE_ATTEMPTS, delay: float = 0.5) -> None:
    """Remplace `target` par `new` (deux renommages dans le même dossier ; `target` restauré en cas d'échec).

    Windows (docs/SUITE.md §9.3) : un dossier dont un fichier est ouvert ne peut pas être renommé ; chaque
    renommage est réessayé (`attempts` fois). Un `aside` resté d'une fois précédente (encore verrouillé) est
    contourné par un nom unique.
    """
    remove_tree(aside)
    if aside.exists():
        aside = aside.with_name(f"{aside.name}-{os.getpid()}-{int(time.time())}")
    moved = False
    if target.exists():
        _retrying(lambda: os.replace(target, aside), attempts, delay)
        moved = True
    try:
        _retrying(lambda: os.replace(new, target), attempts, delay)
    except OSError:
        if moved:
            _retrying(lambda: os.replace(aside, target), attempts, delay)
        raise
    remove_tree(aside)


# --- Variables héritées d'une autre application (docs/SUITE.md §9.4) -------------------------------

FOREIGN_ENV = frozenset(
    {
        # Réglages génériques d'Atelier Viz (app/core/config.py) qu'une autre application pourrait définir pour
        # elle-même : ils désigneraient ses données, son interface, ses hôtes… Ceux de Viz viennent de backend/.env.
        "APP_NAME",
        "APP_ENV",
        "CORS_ORIGINS",
        "ALLOWED_HOSTS",
        "DATA_DIR",
        "MAX_UPLOAD_MB",
        "FRONTEND_DIST",
        "SERVE_FRONTEND",
        "SAMPLES_DIR",
        "SECRETS_BACKEND",
        "ATELIER_HOME",  # paquet autonome
        # Mise à jour : npm ci sans devDependencies (NODE_ENV=production), modules Python d'une autre app.
        # NODE_OPTIONS, NODE_EXTRA_CA_CERTS, npm_config_*proxy* sont gardés : réglages réseau de l'utilisateur.
        "NODE_ENV",
        "NPM_CONFIG_PRODUCTION",
        "NPM_CONFIG_OMIT",
        "NPM_CONFIG_ONLY",
        "NPM_CONFIG_INCLUDE",
        "NPM_CONFIG_GLOBAL",
        "NPM_CONFIG_PREFIX",
        "NPM_CONFIG_LOCAL_PREFIX",
        "PYTHONPATH",
        "PYTHONHOME",
    }
)
"""Variables ignorées au lancement de l'application de bureau (comparées sans tenir compte de la casse)."""

FOREIGN_ENV_PREFIXES = ("NPM_LIFECYCLE_", "NPM_PACKAGE_")
"""Contexte d'un script npm d'une autre application (`npm run …` qui aurait lancé Viz)."""

KEPT_ENV_PREFIXES = (
    "OLLAMA_",
    "CLAUDE_",
    "ANTHROPIC_",
    "AI_",
    "CONNECTOR_",
    "SHAREPOINT_",
    "ATELIER_TAB_",
    "ATELIER_PROJETS_",
    "ATELIER_REPORT_",
    "SCHEDULER_",
    "SYSTEM_NOTIFICATIONS",
    "GITHUB_TOKEN",
)
"""Réglages propres à Viz (préfixe explicite) gardés : tout nouveau réglage relève de l'un ou de `FOREIGN_ENV`."""


def foreign_env_names(env: Mapping[str, str]) -> list[str]:
    """Noms des variables de `env` à ignorer au lancement de l'application de bureau (`FOREIGN_ENV`, contexte npm).

    Les réglages réseau de l'utilisateur (`NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`, `npm_config_https_proxy`,
    `npm_config_registry`…) restent : sans eux, `npm ci` échouerait derrière un proxy d'entreprise.
    """
    return sorted(k for k in env if k.upper() in FOREIGN_ENV or k.upper().startswith(FOREIGN_ENV_PREFIXES))


def scrub_inherited_env(env: MutableMapping[str, str] | None = None) -> list[str]:
    """Retire de `env` (défaut : `os.environ`) les variables héritées d'une autre application ; noms retirés."""
    env = os.environ if env is None else env
    names = foreign_env_names(env)
    for key in names:
        env.pop(key, None)
    return names


# --- Préférences (lues sans dépendance) ------------------------------------------------------------


def local_data_dir(base: Path, env: Mapping[str, str] | None = None) -> Path:
    """Dossier des données comme `Settings.data_dir`, lu sans dépendance.

    `DATA_DIR` de l'environnement, sinon du fichier `.env` de `base`, sinon `data` ; relatif à `base` (le dossier
    courant du serveur, `backend/` pour l'application).
    """
    env = os.environ if env is None else env
    value = env.get("DATA_DIR")
    if not value:
        with contextlib.suppress(OSError):
            for line in (base / ".env").read_text(encoding="utf-8").splitlines():
                key, sep, raw = line.strip().partition("=")
                if sep and key.strip() == "DATA_DIR":
                    value = raw.strip().strip("'\"")
    path = Path(value or "data").expanduser()
    return path if path.is_absolute() else base / path


def online_mode(data_dir: Path) -> bool:
    """Mode en ligne de l'utilisateur (`settings.json`, faux par défaut ou si illisible)."""
    data = _read_json(data_dir / "settings.json")
    return bool(data and data.get("online_mode") is True)


# --- Ligne de commande -----------------------------------------------------------------------------


def _safe_console() -> None:
    """Sortie console tolérante : un caractère hors de la page de code (Windows, sortie redirigée) ne plante pas."""
    for stream in (sys.stdout, sys.stderr):
        with contextlib.suppress(AttributeError, ValueError):
            stream.reconfigure(errors="replace")  # type: ignore[union-attr]


def _console_status(label: str, index: int, total: int) -> None:
    prefix = f"{index}/{total} · " if total else ""
    print(f"{prefix}{label}", flush=True)


def main(argv: list[str] | None = None) -> int:
    """Point d'entrée : voir le module."""
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) == 1 and not args[0].startswith("-"):
        # Lanceur généré avant la mise à jour automatique : il recompilait lui-même. Désormais desktop.py s'en charge.
        print("ok")
        return 0
    parser = argparse.ArgumentParser(prog="python -m app.launcher", description="Mise à jour de l'application")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--mettre-a-jour", dest="update", action="store_true", help="faire la mise à jour (console)")
    mode.add_argument("--plan", action="store_true", help="afficher les étapes nécessaires")
    parser.add_argument("--depot", type=Path, default=ROOT, help="racine du dépôt (défaut : celui de ce fichier)")
    opts = parser.parse_args(args)
    _safe_console()
    scrub_inherited_env()
    updater = Updater(repo=opts.depot.resolve())
    if opts.plan:
        print(" ".join(updater.plan().steps) or "ok")
        return 0
    result = updater.run(_console_status)
    if result.ok:
        print("Application à jour." if result.steps else "Rien à mettre à jour.")
        return 0
    print(f"Erreur : {result.message}\nJournal : {result.log}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
