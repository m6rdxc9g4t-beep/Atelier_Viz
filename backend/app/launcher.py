"""Mise à jour automatique de l'application de bureau après un `git pull` (docs/SUITE.md §8).

Décision de l'utilisateur : après un `git pull`, « Atelier Viz.app » se met à jour toute seule à son lancement
suivant, comme Atelier Projets (`desktop/lib/prepare.cjs`). Le code exécuté est celui du dépôt ; ce module décide
et fait, **seulement si nécessaire** et dans cet ordre :

- `pip`   : `pip install -r requirements.txt [-r requirements-desktop.txt]` avec **le Python de l'application**,
            si ces fichiers (ou l'interpréteur) ont changé depuis la dernière mise à jour réussie ;
- `npm`   : `npm ci` (depuis `frontend/package-lock.json`), si le lockfile a changé ou si `node_modules` manque ;
- `build` : `npm run build` dans un dossier temporaire (`frontend/.dist-next`) puis remplacement de
            `frontend/dist` : la compilation précédente reste servie en cas d'échec.

La décision compare l'**état du dépôt** (empreinte de `HEAD` et du contenu des fichiers suivis modifiés localement)
et les empreintes des fichiers de dépendances au **tampon** de la dernière mise à jour réussie
(`backend/.mise-a-jour.json`, ignoré par git), écrit seulement après une mise à jour entièrement réussie.
Une seule mise à jour à la fois (verrou `backend/.mise-a-jour.lock`). Jamais de `git pull`, jamais de donnée
touchée (`backend/data/` n'est ni lu ni écrit, sauf la lecture du mode en ligne). Réseau : seulement les registres
de paquets (npm, PyPI), pendant les étapes d'installation.

Sous-processus : commandes fixes (aucune donnée en argument), délai borné puis arrêt du groupe, sortie dans le
journal `~/Library/Logs/Atelier Viz/mise-a-jour.log` (taille bornée). Node / npm sont cherchés même depuis le
Finder : `PATH`, `PATH` du shell de connexion zsh, `~/.homebrew/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, nvm.

Bibliothèque standard seulement : fonctionne même si des dépendances Python manquent (c'est l'étape `pip` qui
les installe). Le paquet autonome (PyInstaller) ne l'utilise jamais.

Ligne de commande (depuis `backend/`) :
    python -m app.launcher --mettre-a-jour [--depot DOSSIER]   # mise à jour en console (build_app.sh)
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
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable, Iterator, Mapping, Sequence
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

LOGIN_SHELL = "/bin/zsh"
SYSTEM_BIN_DIRS = ("/opt/homebrew/bin", "/usr/local/bin")
"""Emplacements habituels de Node sur macOS (Homebrew Apple Silicon, Intel / installateur nodejs.org)."""
_PATH_MARK = "__ATELIER_PATH__"


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
                start_new_session=os.name == "posix",
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


def find_git(path: str | None = None) -> str | None:
    """Exécutable `git` absolu (PATH filtré, puis emplacements habituels)."""
    dirs = [*safe_path_dirs(path if path is not None else os.environ.get("PATH", "")), "/usr/bin"]
    dirs += ["/opt/homebrew/bin", "/usr/local/bin"]
    found = shutil.which("git", path=os.pathsep.join(dirs))
    return str(Path(found).resolve()) if found and Path(found).is_absolute() else None


def code_state(repo: Path, git: str | None) -> str:
    """Empreinte du code : commit courant + contenu des fichiers suivis modifiés localement (docs/SUITE.md §8.1).

    Sans git (ou hors d'un dépôt git) : « sans-git » (seules les dépendances et l'interface compilée comptent).
    """
    if git is None:
        return "sans-git"
    head = _capture([git, "-C", str(repo), "rev-parse", "HEAD"], timeout=20)
    if head is None:
        return "sans-git"
    listing = _capture([git, "-C", str(repo), "diff", "--name-only", "-z", "HEAD"], timeout=30) or ""
    changed = sorted(name for name in listing.split("\0") if name)
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


def safe_path_dirs(path: str) -> list[str]:
    """Entrées d'un PATH utilisables : absolues, sans `node_modules/.bin` (jamais un binaire d'un projet)."""
    dirs: list[str] = []
    for entry in path.split(os.pathsep):
        if not entry or not os.path.isabs(entry):
            continue
        if "node_modules" in Path(entry).parts:
            continue
        if entry not in dirs:
            dirs.append(entry)
    return dirs


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


def npm_search_dirs(
    env: Mapping[str, str], home: Path, login_path: Callable[[], str | None] = login_shell_path
) -> list[str]:
    """Dossiers où chercher Node et npm, dans l'ordre (voir le module)."""
    dirs = safe_path_dirs(env.get("PATH", ""))
    for extra in [
        *safe_path_dirs(login_path() or ""),
        str(home / ".homebrew" / "bin"),
        *SYSTEM_BIN_DIRS,
        *nvm_dirs(home, env),
        str(home / ".volta" / "bin"),
    ]:
        if extra not in dirs:
            dirs.append(extra)
    return dirs


def find_npm(
    env: Mapping[str, str] | None = None,
    home: Path | None = None,
    login_path: Callable[[], str | None] = login_shell_path,
) -> Path | None:
    """`npm` absolu dont le dossier contient aussi `node` (npm est un script `node`), ou None."""
    env = os.environ if env is None else env
    for folder in npm_search_dirs(env, home or Path.home(), login_path):
        npm, node = Path(folder) / "npm", Path(folder) / "node"
        if npm.is_file() and os.access(npm, os.X_OK) and node.is_file() and os.access(node, os.X_OK):
            return npm
    return None


# --- Exécution bornée et journalisée ---------------------------------------------------------------


def _stop_group(proc: subprocess.Popen[bytes], grace: float = 5.0) -> None:
    """SIGTERM au groupe du processus (enfants compris), puis SIGKILL après `grace` secondes."""

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
                start_new_session=os.name == "posix",
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


def log_path(platform: str | None = None, home: Path | None = None, env: Mapping[str, str] | None = None) -> Path:
    """Journal de la mise à jour : `~/Library/Logs/Atelier Viz/mise-a-jour.log` sur macOS."""
    platform = platform or sys.platform
    home = home or Path.home()
    env = os.environ if env is None else env
    if platform == "darwin":
        return home / "Library" / "Logs" / "Atelier Viz" / LOG_NAME
    if platform == "win32":
        return Path(env.get("LOCALAPPDATA") or home / "AppData" / "Local") / "Atelier Viz" / LOG_NAME
    return Path(env.get("XDG_STATE_HOME") or home / ".local" / "state") / "atelier-viz" / LOG_NAME


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
    python: str = sys.executable
    log: Path = field(default_factory=log_path)
    runner: Runner = run_logged
    npm_finder: Callable[[], Path | None] = find_npm
    git: str | None = field(default_factory=find_git)
    env: Mapping[str, str] = field(default_factory=lambda: dict(os.environ))
    lock_timeout: float = 30 * 60.0

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

    def run(self, on_status: StatusCallback = lambda label, index, total: None) -> UpdateResult:
        """Exécute les étapes nécessaires sous verrou ; le tampon n'est écrit qu'après un succès complet."""
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
            steps = self.plan().steps  # relu sous verrou : une autre instance a peut-être tout fait
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
            if steps:
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
            raise _StepFailed(
                "Node.js (npm) est introuvable. Installez Node.js (https://nodejs.org ou « brew install node »), "
                "puis relancez l'application."
            )
        env = self._base_env()
        # Dossier de npm en tête : `npm` est un script `#!/usr/bin/env node`.
        env["PATH"] = os.pathsep.join([str(npm.parent), *safe_path_dirs(env.get("PATH", ""))])
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
            cmd = [str(npm), "ci", "--no-audit", "--no-fund", "--loglevel=error"]
            self._exec(step, cmd, self.front, env, "L'installation des dépendances de l'interface (npm ci)")
        else:
            self._build()

    def _build(self) -> None:
        """`npm run build` dans `frontend/.dist-next`, puis remplacement de `frontend/dist` (gardé en cas d'échec)."""
        npm, env = self._npm()
        nxt, old, dist = self.front / NEXT_DIST, self.front / OLD_DIST, self.front / "dist"
        for leftover in (nxt, old):
            shutil.rmtree(leftover, ignore_errors=True)
        # Le script `build` se termine par `vite build` : les options suivantes lui reviennent (chemin relatif).
        cmd = [str(npm), "run", "build", "--", "--outDir", NEXT_DIST, "--emptyOutDir"]
        try:
            self._exec("build", cmd, self.front, env, "La compilation de l'interface")
            if not (nxt / "index.html").is_file():
                raise _StepFailed("La compilation de l'interface n'a pas produit index.html.")
        except _StepFailed:
            shutil.rmtree(nxt, ignore_errors=True)
            raise
        replace_dir(nxt, dist, old)


def replace_dir(new: Path, target: Path, aside: Path) -> None:
    """Remplace `target` par `new` (deux renommages dans le même dossier ; `target` restauré en cas d'échec)."""
    moved = False
    if target.exists():
        os.replace(target, aside)
        moved = True
    try:
        os.replace(new, target)
    except OSError:
        if moved:
            os.replace(aside, target)
        raise
    shutil.rmtree(aside, ignore_errors=True)


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
