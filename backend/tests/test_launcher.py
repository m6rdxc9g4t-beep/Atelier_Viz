"""Mise à jour automatique de « Atelier Viz.app » après un `git pull` (docs/SUITE.md §8, `app/launcher.py`).

Faux dépôt git dans un dossier temporaire ; npm et pip simulés (exécutant injecté, ou faux exécutables pour le
scénario complet) : aucun réseau, aucune vraie installation.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
import sys
import time
from collections.abc import Mapping, Sequence
from pathlib import Path

import pytest

from app import launcher
from app.launcher import Updater, dependencies_current, main, plan_steps, read_stamp, repo_state

ROOT = Path(__file__).resolve().parents[2]
GIT = launcher.find_git()
needs_git = pytest.mark.skipif(GIT is None, reason="git absent")
posix_only = pytest.mark.skipif(os.name == "nt", reason="scripts shell POSIX")
windows_only = pytest.mark.skipif(os.name != "nt", reason="Windows seulement")

GIT_ENV = {
    "GIT_AUTHOR_NAME": "Test",
    "GIT_AUTHOR_EMAIL": "test@example.invalid",
    "GIT_COMMITTER_NAME": "Test",
    "GIT_COMMITTER_EMAIL": "test@example.invalid",
}


def write_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


def git(repo: Path, *args: str) -> None:
    assert GIT is not None
    subprocess.run([GIT, "-C", str(repo), *args], check=True, capture_output=True, env={**os.environ, **GIT_ENV})


def commit(repo: Path, message: str = "maj") -> None:
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", message)


def lock_packages(react: str = "19.1.0") -> dict[str, object]:
    deps = {"dependencies": {"react": "^19.0.0"}, "devDependencies": {"vite": "^7.0.0"}}
    return {
        "": {"name": "f", **deps},
        "node_modules/react": {"version": react},
        "node_modules/vite": {"version": "7.0.1", "dev": True},
        "node_modules/fsevents": {"version": "2.3.3", "devOptional": True},
    }


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    """Dépôt git minimal : interface (sources, lockfile), dépendances Python, données ignorées."""
    return make_repo(tmp_path / "depot")


def make_repo(root: Path) -> Path:
    front = root / "frontend"
    deps = {"dependencies": {"react": "^19.0.0"}, "devDependencies": {"vite": "^7.0.0"}}
    write_json(front / "package.json", {"name": "f", "scripts": {"build": "tsc --noEmit && vite build"}, **deps})
    write_json(front / "package-lock.json", {"lockfileVersion": 3, "packages": lock_packages()})
    (front / "src").mkdir()
    (front / "src" / "main.tsx").write_text("export const v = 1\n", encoding="utf-8")
    (root / "backend").mkdir()
    (root / "backend" / "requirements.txt").write_text("fastapi>=0.132\n", encoding="utf-8")
    (root / "backend" / "requirements-desktop.txt").write_text("pywebview>=5.3\n", encoding="utf-8")
    (root / ".gitignore").write_text(
        "node_modules/\ndist/\nbackend/data/\nbackend/.mise-a-jour.*\nfrontend/.dist-*/\n", encoding="utf-8"
    )
    (root / ".gitattributes").write_text("* text=auto eol=lf\n", encoding="utf-8")  # comme le dépôt (§9.3)
    data = root / "backend" / "data"
    data.mkdir()
    (data / "atelier.duckdb").write_bytes(b"donnees-utilisateur")
    if GIT is not None:
        git(root, "init", "-q")
        commit(root, "initial")
    return root


class FakeRunner:
    """Simule pip et npm : `npm ci` écrit node_modules, `npm run build -- --outDir X` écrit X/index.html."""

    def __init__(self) -> None:
        self.calls: list[list[str]] = []
        self.fail: set[str] = set()
        self.builds = 0

    @staticmethod
    def step_of(cmd: Sequence[str]) -> str:
        if "pip" in cmd:
            return "pip"
        return "npm" if "ci" in cmd else "build"

    @property
    def steps(self) -> list[str]:
        return [self.step_of(c) for c in self.calls]

    def __call__(self, cmd: Sequence[str], *, cwd: Path, env: Mapping[str, str], log: Path, timeout: float) -> int:
        self.calls.append(list(cmd))
        step = self.step_of(cmd)
        if step in self.fail:
            return 1
        if step == "npm":
            lock = json.loads((cwd / "package-lock.json").read_text(encoding="utf-8"))
            installed = {k: v for k, v in lock["packages"].items() if k and "fsevents" not in k}
            write_json(cwd / "node_modules" / ".package-lock.json", {"packages": installed})
        elif step == "build":
            out = cwd / cmd[cmd.index("--outDir") + 1]
            out.mkdir(parents=True, exist_ok=True)
            self.builds += 1
            (out / "index.html").write_text(f'<div id="root"></div> compilation {self.builds}', encoding="utf-8")
        return 0


@pytest.fixture
def runner() -> FakeRunner:
    return FakeRunner()


def make_updater(repo: Path, runner: FakeRunner, tmp_path: Path, python: str = "/env/bin/python") -> Updater:
    npm = tmp_path / "node" / "bin" / "npm"
    return Updater(
        repo=repo,
        python=python,
        log=tmp_path / "logs" / "mise-a-jour.log",
        runner=runner,
        npm_finder=lambda: npm,
        git=GIT,
        env={"PATH": "/usr/bin:/bin"},
        lock_timeout=0.3,
    )


def dist_text(repo: Path) -> str:
    return (repo / "frontend" / "dist" / "index.html").read_text(encoding="utf-8")


# --- Décision ------------------------------------------------------------------------------------


@needs_git
def test_first_update_then_nothing_to_do(repo: Path, runner: FakeRunner, tmp_path: Path) -> None:
    updater = make_updater(repo, runner, tmp_path)
    assert updater.plan().steps == ("pip", "npm", "build")
    result = updater.run()
    assert result.ok and result.steps == ("pip", "npm", "build")
    assert runner.steps == ["pip", "npm", "build"]
    assert read_stamp(updater.stamp_path) == updater.plan().state
    assert "compilation 1" in dist_text(repo)
    # Rien n'a changé : aucune étape, aucune commande.
    runner.calls.clear()
    assert updater.plan().steps == ()
    assert updater.run().ok and runner.calls == []
    # Les données ne sont jamais touchées ; le tampon est ignoré par git.
    assert (repo / "backend" / "data" / "atelier.duckdb").read_bytes() == b"donnees-utilisateur"
    status = subprocess.run([GIT, "-C", str(repo), "status", "--porcelain"], capture_output=True, text=True)  # type: ignore[list-item]
    assert status.stdout == ""


@needs_git
def test_new_commit_only_rebuilds(repo: Path, runner: FakeRunner, tmp_path: Path) -> None:
    updater = make_updater(repo, runner, tmp_path)
    assert updater.run().ok
    (repo / "frontend" / "src" / "main.tsx").write_text("export const v = 2\n", encoding="utf-8")
    commit(repo)  # git pull
    runner.calls.clear()
    assert updater.plan().steps == ("build",)
    assert updater.run().ok and runner.steps == ["build"]
    assert "compilation 2" in dist_text(repo)


@needs_git
def test_changed_lockfile_runs_npm_ci_then_build(repo: Path, runner: FakeRunner, tmp_path: Path) -> None:
    """Cas réel : la mise à jour ajoute un paquet (pdf-lib) à l'interface."""
    updater = make_updater(repo, runner, tmp_path)
    assert updater.run().ok
    packages = lock_packages()
    packages["node_modules/pdf-lib"] = {"version": "1.17.1"}
    write_json(repo / "frontend" / "package-lock.json", {"lockfileVersion": 3, "packages": packages})
    commit(repo)
    runner.calls.clear()
    assert updater.run().ok
    assert runner.steps == ["npm", "build"]
    assert runner.calls[0][1:] == ["ci", "--no-audit", "--no-fund", "--loglevel=error"]
    assert "node_modules/pdf-lib" in (repo / "frontend" / "node_modules" / ".package-lock.json").read_text()


@needs_git
def test_changed_requirements_run_pip_with_the_app_python(repo: Path, runner: FakeRunner, tmp_path: Path) -> None:
    updater = make_updater(repo, runner, tmp_path)
    assert updater.run().ok
    (repo / "backend" / "requirements.txt").write_text("fastapi>=0.132\nrich>=13\n", encoding="utf-8")
    commit(repo)
    runner.calls.clear()
    assert updater.run().ok
    assert runner.steps == ["pip", "build"]  # nouveau commit : l'interface est aussi recompilée
    pip = runner.calls[0]
    assert pip[:4] == ["/env/bin/python", "-m", "pip", "install"]
    assert pip[-4:] == ["-r", "requirements.txt", "-r", "requirements-desktop.txt"]


@needs_git
def test_other_python_reinstalls_dependencies_only(repo: Path, runner: FakeRunner, tmp_path: Path) -> None:
    """build_app.sh relancé avec un autre environnement Python : pip, sans recompiler."""
    assert make_updater(repo, runner, tmp_path).run().ok
    runner.calls.clear()
    other = make_updater(repo, runner, tmp_path, python="/autre/bin/python3")
    assert other.run().ok and runner.steps == ["pip"]
    assert runner.calls[0][0] == "/autre/bin/python3"


@needs_git
def test_local_modification_counts_as_a_change(repo: Path, runner: FakeRunner, tmp_path: Path) -> None:
    updater = make_updater(repo, runner, tmp_path)
    assert updater.run().ok
    source = repo / "frontend" / "src" / "main.tsx"
    source.write_text("export const v = 'local'\n", encoding="utf-8")  # non commité
    assert updater.plan().steps == ("build",)
    assert updater.run().ok and updater.plan().steps == ()
    source.write_text("export const v = 'local 2'\n", encoding="utf-8")  # contenu, pas seulement le nom
    assert updater.plan().steps == ("build",)
    git(repo, "checkout", "--", "frontend/src/main.tsx")  # retour au commit
    assert updater.plan().steps == ("build",)


@needs_git
def test_new_untracked_file_counts_as_a_change(repo: Path, runner: FakeRunner, tmp_path: Path) -> None:
    """docs/SUITE.md §8.4 : un fichier nouveau non ignoré compte ; un fichier ignoré (données) jamais."""
    updater = make_updater(repo, runner, tmp_path)
    assert updater.run().ok
    (repo / "backend" / "data" / "rapport.json").write_text("{}", encoding="utf-8")  # ignoré
    assert updater.plan().steps == ()
    extra = repo / "frontend" / "src" / "nouveau.tsx"
    extra.write_text("export const n = 1\n", encoding="utf-8")
    assert updater.plan().steps == ("build",)
    assert updater.run().ok and updater.plan().steps == ()
    extra.write_text("export const n = 2\n", encoding="utf-8")  # son contenu compte aussi
    assert updater.plan().steps == ("build",)


def test_changed_paths_from_git_status() -> None:
    listing = " M frontend/src/a.ts\0?? frontend/src/b.ts\0R  nouveau.ts\0ancien.ts\0 D supprimé.ts\0"
    assert launcher.changed_paths(listing) == sorted(
        ["frontend/src/a.ts", "frontend/src/b.ts", "nouveau.ts", "ancien.ts", "supprimé.ts"]
    )
    assert launcher.changed_paths("") == []


@needs_git
def test_missing_build_or_node_modules_is_repaired(repo: Path, runner: FakeRunner, tmp_path: Path) -> None:
    updater = make_updater(repo, runner, tmp_path)
    assert updater.run().ok
    shutil.rmtree(repo / "frontend" / "dist")
    assert updater.plan().steps == ("build",)
    shutil.rmtree(repo / "frontend" / "node_modules")
    assert updater.plan().steps == ("npm", "build")


def test_without_stamp_current_node_modules_are_kept(repo: Path, tmp_path: Path) -> None:
    """Premier lancement après cette version : node_modules conforme au lockfile → pas de npm ci."""
    front = repo / "frontend"
    installed = {k: v for k, v in lock_packages().items() if k and "fsevents" not in k}
    write_json(front / "node_modules" / ".package-lock.json", {"packages": installed})
    assert dependencies_current(front) is True
    state = repo_state(repo, "/env/bin/python", None)
    assert plan_steps(repo, state, None) == ("pip", "build")
    installed["node_modules/react"] = {"version": "19.0.0"}
    write_json(front / "node_modules" / ".package-lock.json", {"packages": installed})
    assert plan_steps(repo, state, None) == ("pip", "npm", "build")


@needs_git
def test_pip_first_then_the_rest_writes_the_stamp_once(repo: Path, runner: FakeRunner, tmp_path: Path) -> None:
    """Windows : `pip` avant l'ouverture de la fenêtre (`only`), puis le reste ; pip n'est pas refait."""
    updater = make_updater(repo, runner, tmp_path)
    first = updater.run(only={"pip"})
    assert first.ok and first.steps == ("pip",) and runner.steps == ["pip"]
    assert not updater.stamp_path.exists()  # rien n'est fini : pas de tampon
    rest = updater.run()
    assert rest.ok and rest.steps == ("npm", "build") and runner.steps == ["pip", "npm", "build"]
    assert read_stamp(updater.stamp_path) == updater.plan().state and updater.plan().steps == ()
    assert updater.done == set()  # vidé après l'appel complet
    # Échec de pip avant la fenêtre : rien d'autre n'est lancé.
    (repo / "backend" / "requirements.txt").write_text("fastapi>=0.140\n", encoding="utf-8")
    runner.calls.clear()
    runner.fail = {"pip"}
    failed = updater.run(only={"pip"})
    assert not failed.ok and failed.failed_step == "pip" and runner.steps == ["pip"]


def test_unreadable_stamp_means_full_update(repo: Path, tmp_path: Path) -> None:
    stamp = repo / "backend" / launcher.STAMP_NAME
    stamp.write_text("{pas du json", encoding="utf-8")
    assert read_stamp(stamp) is None
    write_json(stamp, {"code": "x"})
    assert read_stamp(stamp) is None


# --- Échecs, verrou --------------------------------------------------------------------------------


@needs_git
def test_failed_build_keeps_previous_build_and_stamp(repo: Path, runner: FakeRunner, tmp_path: Path) -> None:
    updater = make_updater(repo, runner, tmp_path)
    assert updater.run().ok
    stamp_before = updater.stamp_path.read_text(encoding="utf-8")
    (repo / "frontend" / "src" / "main.tsx").write_text("export const v = 3\n", encoding="utf-8")
    commit(repo)
    runner.fail = {"build"}
    result = updater.run()
    assert not result.ok and result.failed_step == "build" and not result.network
    assert result.previous_available and result.log == str(updater.log)
    assert "compilation de l'interface a échoué" in (result.message or "")
    assert "compilation 1" in dist_text(repo)  # l'ancienne compilation reste servie
    assert not (repo / "frontend" / launcher.NEXT_DIST).exists()
    assert updater.stamp_path.read_text(encoding="utf-8") == stamp_before
    assert updater.plan().steps == ("build",)  # le lancement suivant réessaie
    runner.fail = set()
    assert updater.run().ok and "compilation 2" in dist_text(repo)


@needs_git
def test_failed_install_stops_before_build(repo: Path, runner: FakeRunner, tmp_path: Path) -> None:
    updater = make_updater(repo, runner, tmp_path)
    runner.fail = {"pip"}
    result = updater.run()
    assert not result.ok and result.failed_step == "pip" and result.network
    assert "connexion au réseau" in (result.message or "")
    assert runner.steps == ["pip"] and not updater.stamp_path.exists()
    assert result.previous_available is False  # jamais compilée : pas de version précédente


@needs_git
def test_missing_npm_is_a_clear_failure(repo: Path, runner: FakeRunner, tmp_path: Path) -> None:
    updater = make_updater(repo, runner, tmp_path)
    updater.npm_finder = lambda: None
    result = updater.run()
    assert not result.ok and result.failed_step == "npm"
    assert "Node.js (npm) est introuvable" in (result.message or "")


@needs_git
def test_lock_allows_a_single_update(repo: Path, runner: FakeRunner, tmp_path: Path) -> None:
    updater = make_updater(repo, runner, tmp_path)
    statuses: list[tuple[str, int, int]] = []
    with launcher.update_lock(updater.lock_path, 0) as held:
        assert held
        result = updater.run(lambda label, i, n: statuses.append((label, i, n)))
    assert not result.ok and result.busy and runner.calls == []
    assert statuses and statuses[0][1:] == (0, 0) and "autre mise à jour" in statuses[0][0]
    assert updater.run().ok  # verrou libéré


def test_replace_dir_restores_the_previous_folder(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    new, target, aside = tmp_path / "new", tmp_path / "dist", tmp_path / "old"
    new.mkdir()
    (new / "index.html").write_text("neuf", encoding="utf-8")
    target.mkdir()
    (target / "index.html").write_text("ancien", encoding="utf-8")
    real = os.replace

    def failing(src: object, dst: object) -> None:
        if Path(str(src)) == new:
            raise OSError("disque plein")
        real(src, dst)  # type: ignore[arg-type]

    monkeypatch.setattr(launcher.os, "replace", failing)
    with pytest.raises(OSError):
        launcher.replace_dir(new, target, aside)
    assert (target / "index.html").read_text(encoding="utf-8") == "ancien"
    monkeypatch.setattr(launcher.os, "replace", real)
    launcher.replace_dir(new, target, aside)
    assert (target / "index.html").read_text(encoding="utf-8") == "neuf" and not aside.exists()


def test_replace_dir_retries_while_windows_holds_a_file(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Windows (§9.3) : un dossier dont un fichier est ouvert ne se renomme pas ; on réessaie, puis on abandonne."""
    new, target, aside = tmp_path / "new", tmp_path / "dist", tmp_path / "old"
    for folder, text in ((new, "neuf"), (target, "ancien")):
        folder.mkdir()
        (folder / "index.html").write_text(text, encoding="utf-8")
    real = os.replace
    refusals = {"left": 2}

    def busy(src: object, dst: object) -> None:
        if Path(str(src)) == target and refusals["left"] > 0:
            refusals["left"] -= 1
            raise PermissionError("utilisé par un autre processus")
        real(src, dst)  # type: ignore[arg-type]

    monkeypatch.setattr(launcher.os, "replace", busy)
    launcher.replace_dir(new, target, aside, attempts=3, delay=0)
    assert (target / "index.html").read_text(encoding="utf-8") == "neuf"
    # Toujours verrouillé : erreur, et l'interface en place n'a pas bougé.
    new.mkdir()
    (new / "index.html").write_text("encore", encoding="utf-8")
    refusals["left"] = 99
    with pytest.raises(PermissionError):
        launcher.replace_dir(new, target, aside, attempts=3, delay=0)
    assert (target / "index.html").read_text(encoding="utf-8") == "neuf" and new.is_dir()


def test_replace_dir_avoids_a_leftover_aside_folder(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    new, target, aside = tmp_path / "new", tmp_path / "dist", tmp_path / ".dist-old"
    for folder in (new, target, aside):
        folder.mkdir()
        (folder / "index.html").write_text(folder.name, encoding="utf-8")
    monkeypatch.setattr(launcher, "remove_tree", lambda path: None)  # reste d'une fois précédente, verrouillé
    launcher.replace_dir(new, target, aside)
    assert (target / "index.html").read_text(encoding="utf-8") == "new"
    assert aside.is_dir() and any(p.name.startswith(".dist-old-") for p in tmp_path.iterdir())


@needs_git
def test_locked_dist_is_a_clear_failure(
    repo: Path, runner: FakeRunner, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    updater = make_updater(repo, runner, tmp_path)
    assert updater.run().ok
    commit_file = repo / "frontend" / "src" / "main.tsx"
    commit_file.write_text("export const v = 5\n", encoding="utf-8")

    def locked(*_: object, **__: object) -> None:
        raise PermissionError("utilisé par un autre processus")

    monkeypatch.setattr(launcher, "replace_dir", locked)
    result = updater.run()
    assert not result.ok and result.failed_step == "build" and result.previous_available
    assert "prochain lancement" in (result.message or "")
    assert "compilation 1" in dist_text(repo) and not (repo / "frontend" / launcher.NEXT_DIST).exists()
    assert updater.plan().steps == ("build",)


# --- Exécution bornée -------------------------------------------------------------------------------


def test_run_logged_writes_the_log_and_bounds_time(tmp_path: Path) -> None:
    log = tmp_path / "logs" / "mise-a-jour.log"
    env = {"PATH": os.environ.get("PATH", "")}
    code = launcher.run_logged([sys.executable, "-c", "print('bonjour')"], cwd=tmp_path, env=env, log=log, timeout=30)
    assert code == 0 and "bonjour" in log.read_text(encoding="utf-8")
    code = launcher.run_logged(
        [sys.executable, "-c", "raise SystemExit(3)"], cwd=tmp_path, env=env, log=log, timeout=30
    )
    assert code == 3
    start = time.monotonic()
    code = launcher.run_logged(
        [sys.executable, "-c", "import time; time.sleep(30)"], cwd=tmp_path, env=env, log=log, timeout=0.5
    )
    assert code == -1 and time.monotonic() - start < 15
    assert "délai" in log.read_text(encoding="utf-8")
    flood = "import sys\nwhile True: sys.stdout.write('x' * 65536)"
    code = launcher.run_logged(
        [sys.executable, "-c", flood], cwd=tmp_path, env=env, log=log, timeout=30, max_log=200_000
    )
    assert code == -1 and "sortie trop longue" in log.read_text(encoding="utf-8")


def test_log_location_per_platform(tmp_path: Path) -> None:
    mac = launcher.log_path("darwin", tmp_path, {})
    assert mac == tmp_path / "Library" / "Logs" / "Atelier Viz" / "mise-a-jour.log"
    assert launcher.log_path("linux", tmp_path, {}) == tmp_path / ".local" / "state" / "atelier-viz" / "mise-a-jour.log"
    # Windows (docs/SUITE.md §9.2) : %LOCALAPPDATA%\Atelier Viz\Logs\
    local = tmp_path / "Local Fran\u00e7ois"
    win = launcher.log_path("win32", tmp_path, {"LOCALAPPDATA": str(local)})
    assert win == local / "Atelier Viz" / "Logs" / "mise-a-jour.log"
    assert launcher.logs_dir("win32", tmp_path, {}) == tmp_path / "AppData" / "Local" / "Atelier Viz" / "Logs"


# --- Node / npm depuis le Finder ---------------------------------------------------------------------


def fake_bin(folder: Path, *names: str) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    for name in names:
        exe = folder / name
        exe.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        exe.chmod(exe.stat().st_mode | stat.S_IXUSR)
    return folder


@pytest.fixture
def no_system_node(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ignore le Node éventuellement installé sur la machine de test."""
    monkeypatch.setattr(launcher, "SYSTEM_BIN_DIRS", ())


@posix_only
@pytest.mark.usefixtures("no_system_node")
def test_npm_found_outside_the_finder_path(tmp_path: Path) -> None:
    home = tmp_path / "home"
    env = {"PATH": "/usr/bin:/bin:relatif:/x/node_modules/.bin"}
    assert launcher.find_npm(env, home, lambda: None, "darwin") is None
    # Homebrew de l'utilisateur (~/.homebrew/bin)
    brew = fake_bin(home / ".homebrew" / "bin", "node", "npm")
    assert launcher.find_npm(env, home, lambda: None, "darwin") == brew / "npm"
    # Le PATH du shell de connexion passe avant les emplacements habituels.
    login = fake_bin(tmp_path / "login-bin", "node", "npm")
    assert launcher.find_npm(env, home, lambda: str(login), "darwin") == login / "npm"
    # npm sans node à côté : ignoré.
    lonely = fake_bin(tmp_path / "seul", "npm")
    assert launcher.find_npm({"PATH": str(lonely)}, home, lambda: None, "darwin") == brew / "npm"


@posix_only
@pytest.mark.usefixtures("no_system_node")
def test_npm_from_nvm_prefers_the_default_alias(tmp_path: Path) -> None:
    home = tmp_path / "home"
    versions = home / ".nvm" / "versions" / "node"
    for v in ("v18.20.0", "v20.11.1", "v22.3.0"):
        fake_bin(versions / v / "bin", "node", "npm")
    assert launcher.find_npm({"PATH": ""}, home, lambda: None, "darwin") == versions / "v22.3.0" / "bin" / "npm"
    (home / ".nvm" / "alias").mkdir(parents=True)
    (home / ".nvm" / "alias" / "default").write_text("20\n", encoding="utf-8")
    assert launcher.find_npm({"PATH": ""}, home, lambda: None, "darwin") == versions / "v20.11.1" / "bin" / "npm"


def test_path_entries_are_filtered() -> None:
    dirs = launcher.safe_path_dirs("/a:rel:./b::/a:/p/node_modules/.bin:/c", "darwin")
    assert dirs == ["/a", "/c"]
    path = r'C:\Windows\system32;rel;.\b;;"C:\Program Files\nodejs";C:\p\node_modules\.bin;\\srv\outils'
    win = launcher.safe_path_dirs(path + r";C:\Windows\system32", "win32")
    assert win == [r"C:\Windows\system32", r"C:\Program Files\nodejs", r"\\srv\outils"]


def win_bin(folder: Path, *names: str) -> Path:
    """Faux exécutables Windows (fichiers vides : seule leur présence compte pour la recherche)."""
    folder.mkdir(parents=True, exist_ok=True)
    for name in names:
        (folder / name).write_bytes(b"")
    return folder


def test_npm_found_in_the_usual_windows_places(tmp_path: Path) -> None:
    """docs/SUITE.md §9.3 : PATH, PATH du registre, Program Files, nvm-windows, Volta, fnm, LOCALAPPDATA."""
    home = tmp_path / "Users" / "Fran\u00e7ois"
    local, roaming, program = tmp_path / "Local", tmp_path / "Roaming", tmp_path / "Program Files"
    env = {
        "PATH": r"C:\Windows\system32;relatif",
        "LOCALAPPDATA": str(local),
        "APPDATA": str(roaming),
        "ProgramFiles": str(program),
    }

    def find(extra: dict[str, str] | None = None, login: str | None = None) -> Path | None:
        return launcher.find_npm({**env, **(extra or {})}, home, lambda: login, platform="win32")

    assert find() is None
    # Installateur nodejs.org dans le dossier de l'utilisateur.
    user_node = win_bin(local / "Programs" / "nodejs", "node.exe", "npm.cmd")
    assert find() == user_node / "npm.cmd"
    # fnm, puis Volta (npm.exe), puis nvm-windows passent avant (ordre §9.3).
    fnm = win_bin(roaming / "fnm" / "aliases" / "default", "node.exe", "npm.cmd")
    assert find() == fnm / "npm.cmd"
    volta = win_bin(local / "Volta" / "bin", "node.exe", "npm.exe")
    assert find() == volta / "npm.exe"
    nvm = win_bin(tmp_path / "nvm4w" / "nodejs", "node.exe", "npm.cmd")
    assert find({"NVM_SYMLINK": str(nvm)}) == nvm / "npm.cmd"
    machine = win_bin(program / "nodejs", "node.exe", "npm.cmd")
    assert find({"NVM_SYMLINK": str(nvm)}) == machine / "npm.cmd"
    # npm sans node.exe à côté : ignoré.
    lonely = win_bin(tmp_path / "seul", "npm.cmd")
    assert find({"NVM_SYMLINK": str(lonely)}) == machine / "npm.cmd"


@windows_only
def test_windows_path_and_registry_path_come_first(tmp_path: Path) -> None:
    """PATH du processus, puis PATH du registre (Node installé après l'ouverture de session), puis le reste."""
    machine = win_bin(tmp_path / "Program Files" / "nodejs", "node.exe", "npm.cmd")
    env = {"PATH": r"C:\Windows\system32;relatif", "ProgramFiles": str(tmp_path / "Program Files")}
    home = tmp_path / "home"
    registry = win_bin(tmp_path / "registre", "node.exe", "npm.cmd")
    assert launcher.find_npm(env, home, lambda: f"C:\\Windows;{registry}", "win32") == registry / "npm.cmd"
    first = win_bin(tmp_path / "chemin avec espaces", "node.exe", "npm.cmd")
    found = launcher.find_npm({**env, "PATH": f"{first};{registry}"}, home, lambda: str(registry), "win32")
    assert found == first / "npm.cmd"
    project = win_bin(tmp_path / "projet" / "node_modules" / ".bin", "node.exe", "npm.cmd")
    assert launcher.find_npm({**env, "PATH": str(project)}, home, lambda: None, "win32") == machine / "npm.cmd"


def test_git_found_in_the_usual_windows_places(tmp_path: Path) -> None:
    env = {"PATH": r"C:\outils", "ProgramFiles": r"C:\Program Files", "LOCALAPPDATA": r"C:\Users\F\AppData\Local"}
    dirs = launcher.git_search_dirs(env, "win32")
    assert dirs == [
        r"C:\outils",
        str(Path(r"C:\Program Files") / "Git" / "cmd"),
        str(Path(env["LOCALAPPDATA"]) / "Programs" / "Git" / "cmd"),
    ]
    assert "/usr/bin" in launcher.git_search_dirs({"PATH": "/x"}, "darwin")


def test_app_python_prefers_the_console_interpreter(tmp_path: Path) -> None:
    """Le raccourci lance pythonw.exe ; le tampon et pip utilisent python.exe du même environnement."""
    scripts = win_bin(tmp_path / "venv" / "Scripts", "python.exe", "pythonw.exe")
    assert launcher.app_python(str(scripts / "pythonw.exe"), "win32") == str(scripts / "python.exe")
    assert launcher.app_python(str(scripts / "PythonW.EXE"), "win32") == str(scripts / "python.exe")
    assert launcher.app_python(str(scripts / "python.exe"), "win32") == str(scripts / "python.exe")
    alone = win_bin(tmp_path / "seul", "pythonw.exe")
    assert launcher.app_python(str(alone / "pythonw.exe"), "win32") == str(alone / "pythonw.exe")
    assert launcher.app_python("/env/bin/pythonw.exe", "darwin") == "/env/bin/pythonw.exe"


@windows_only
def test_registry_path_reads_the_session_path() -> None:
    path = launcher.registry_path()
    assert path is not None and "system32" in path.lower()
    assert launcher.system_login_path() == path


@posix_only
def test_login_shell_path_is_read_between_marks(tmp_path: Path) -> None:
    shell = tmp_path / "zsh"
    shell.write_text(
        '#!/bin/sh\necho "bienvenue"\nprintf "__ATELIER_PATH__/opt/homebrew/bin:/usr/bin__ATELIER_PATH__"\n',
        encoding="utf-8",
    )
    shell.chmod(0o755)
    assert launcher.login_shell_path(str(shell)) == "/opt/homebrew/bin:/usr/bin"
    assert launcher.login_shell_path(str(tmp_path / "absent")) is None


# --- Préférences, ligne de commande, scripts ------------------------------------------------------------


def test_online_mode_is_read_without_dependencies(tmp_path: Path) -> None:
    base = tmp_path / "backend"
    base.mkdir()
    assert launcher.local_data_dir(base, {}) == base / "data"
    elsewhere = tmp_path / "srv" / "viz"
    (base / ".env").write_text(f"CLAUDE_MODE=api\nDATA_DIR='{elsewhere}'\n", encoding="utf-8")
    assert launcher.local_data_dir(base, {}) == elsewhere
    assert launcher.local_data_dir(base, {"DATA_DIR": "ailleurs"}) == base / "ailleurs"
    data = base / "data"
    assert launcher.online_mode(data) is False
    write_json(data / "settings.json", {"online_mode": True})
    assert launcher.online_mode(data) is True
    (data / "settings.json").write_text("{", encoding="utf-8")
    assert launcher.online_mode(data) is False


@needs_git
def test_command_line(repo: Path, capsys: pytest.CaptureFixture[str]) -> None:
    # Anciens lanceurs (python -m app.launcher <frontend>) : « ok », desktop.py fait la mise à jour.
    assert main([str(repo / "frontend")]) == 0
    assert capsys.readouterr().out.strip() == "ok"
    assert main(["--plan", "--depot", str(repo)]) == 0
    assert capsys.readouterr().out.strip() == "pip npm build"
    out = subprocess.run(
        [sys.executable, "-m", "app.launcher", "--plan", "--depot", str(repo)],
        cwd=ROOT / "backend",
        capture_output=True,
        text=True,
        check=True,
    )
    assert out.stdout.strip() == "pip npm build"


def test_frontend_build_script_ends_with_vite_build() -> None:
    """`npm run build -- --outDir .dist-next` : les options doivent revenir à `vite build`."""
    package = json.loads((ROOT / "frontend" / "package.json").read_text(encoding="utf-8"))
    assert package["scripts"]["build"].rstrip().endswith("vite build")


def test_update_files_are_ignored_by_git() -> None:
    ignore = (ROOT / ".gitignore").read_text(encoding="utf-8")
    for pattern in ("backend/.mise-a-jour.*", "frontend/.dist-*/", "backend/data/"):
        assert pattern in ignore


def test_build_app_delegates_the_update() -> None:
    """build_app.sh fait la première mise à jour par app.launcher ; le lanceur généré ouvre desktop.py."""
    script = (ROOT / "scripts" / "macos" / "build_app.sh").read_text(encoding="utf-8")
    assert "-m app.launcher --mettre-a-jour" in script
    body = re.search(r"cat <<'LAUNCHER'\n(.*?)\nLAUNCHER\n", script, re.S)
    assert body is not None
    code = "\n".join(line for line in body.group(1).splitlines() if not line.lstrip().startswith("#"))
    assert "desktop.py" in code and "npm " not in code and "pip " not in code  # tout passe par app.launcher
    # Jamais de git pull automatique : le lanceur n'appelle pas git, la mise à jour ne fait que lire le dépôt.
    assert "git" not in code
    source = (ROOT / "backend" / "app" / "launcher.py").read_text(encoding="utf-8")
    assert '"pull"' not in source and '"fetch"' not in source


# --- Variables héritées d'une autre application (docs/SUITE.md §9.4) --------------------------------------


def test_inherited_variables_of_other_apps_are_ignored() -> None:
    env = {
        "DATA_DIR": "/autre-app/data",
        "data_dir": "/autre-app/data",  # pydantic-settings ignore la casse
        "Frontend_Dist": "/autre-app/dist",
        "NODE_ENV": "production",  # npm ci sans devDependencies : la compilation échouerait
        "PYTHONPATH": "/autre-app/backend",
        "npm_config_omit": "dev",
        "npm_config_registry": "https://registre.entreprise.example",  # réglage volontaire de l'utilisateur
        "PATH": "/usr/bin",
        "HOME": "/Users/f",
        "CLAUDE_CLI": "/opt/claude",
        "OLLAMA_MODEL": "llama3.2",
        "ATELIER_TAB_EXPORTS_DIR": "/Users/f/Atelier_Tab/exports",
    }
    removed = launcher.scrub_inherited_env(env)
    assert removed == sorted(["DATA_DIR", "data_dir", "Frontend_Dist", "NODE_ENV", "PYTHONPATH", "npm_config_omit"])
    assert set(env) == {"PATH", "HOME", "CLAUDE_CLI", "OLLAMA_MODEL", "ATELIER_TAB_EXPORTS_DIR", "npm_config_registry"}
    # Lancée depuis un script npm d'une autre app : son contexte est ignoré, pas les réglages réseau.
    npm_run = {
        "npm_lifecycle_event": "start",
        "npm_package_name": "atelier-tab",
        "npm_config_local_prefix": "/autre-app",
        "npm_config_https_proxy": "http://proxy:3128",
        "NODE_OPTIONS": "--use-openssl-ca",
        "PATH": "/b",
    }
    assert launcher.scrub_inherited_env(npm_run) == [
        "npm_config_local_prefix",
        "npm_lifecycle_event",
        "npm_package_name",
    ]
    assert npm_run == {"npm_config_https_proxy": "http://proxy:3128", "NODE_OPTIONS": "--use-openssl-ca", "PATH": "/b"}


def test_every_setting_is_classified_for_the_desktop_launch() -> None:
    """Tout réglage de Settings est soit propre à Viz (préfixe gardé), soit ignoré s'il est hérité (FOREIGN_ENV)."""
    from pydantic import AliasChoices

    from app.core.config import Settings

    for name, info in Settings.model_fields.items():
        aliases = info.validation_alias.choices if isinstance(info.validation_alias, AliasChoices) else [name]
        for alias in aliases:
            env_name = str(alias).upper()
            kept = env_name.startswith(launcher.KEPT_ENV_PREFIXES)
            assert kept != (env_name in launcher.FOREIGN_ENV), f"{env_name} : à classer (FOREIGN_ENV ou préfixe gardé)"


def test_command_line_ignores_inherited_variables(repo: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv("DATA_DIR", "/autre-app/data")
    assert main(["--plan", "--depot", str(repo)]) == 0
    assert "NODE_ENV" not in os.environ and "DATA_DIR" not in os.environ


# --- Scénario complet : vrais sous-processus, faux npm et faux Python -------------------------------------


FAKE_NPM = """#!/bin/sh
# Faux npm : journalise ses arguments, simule `ci` et `run build -- --outDir X`.
echo "npm $*" >> "$FAKE_CALLS"
command -v node >/dev/null || { echo "node introuvable" >&2; exit 9; }
if [ "$1" = "ci" ]; then
  mkdir -p node_modules && cp package-lock.json node_modules/.package-lock.json && exit 0
fi
if [ "$1" = "run" ] && [ "$2" = "build" ]; then
  [ -f "$FAKE_FAIL_BUILD" ] && { echo "erreur de compilation" >&2; exit 2; }
  out="$5"; mkdir -p "$out" && echo '<div id="root"></div> nouvelle' > "$out/index.html" && exit 0
fi
exit 1
"""

FAKE_PYTHON = """#!/bin/sh
echo "python $*" >> "$FAKE_CALLS"
exit 0
"""

# Windows : npm.cmd à côté de node.exe (installateur nodejs.org), lancé sans shell avec des arguments fixes.
FAKE_NPM_CMD = r"""@echo off
echo npm %*>> "%FAKE_CALLS%"
where node.exe >nul 2>nul || (echo node introuvable 1>&2 & exit /b 9)
if "%1"=="ci" (
  if not exist node_modules mkdir node_modules
  copy /y package-lock.json node_modules\.package-lock.json >nul
  exit /b 0
)
if "%1"=="run" if "%2"=="build" (
  if exist "%FAKE_FAIL_BUILD%" (echo erreur de compilation 1>&2 & exit /b 2)
  if not exist "%5" mkdir "%5"
  echo ^<div id="root"^>^</div^> nouvelle> "%5\index.html"
  exit /b 0
)
exit /b 1
"""

FAKE_PYTHON_CMD = r"""@echo off
echo python %*>> "%FAKE_CALLS%"
exit /b 0
"""


def fake_tools(tmp_path: Path) -> tuple[Path, Path, dict[str, str]]:
    """(dossier personnel, faux Python, environnement) : faux npm + node dans un dossier avec espaces et accents."""
    home = tmp_path / "home"
    if os.name == "nt":
        node_dir = tmp_path / "Program Files" / "Node JS \u00e9t\u00e9"
        win_bin(node_dir, "node.exe")
        (node_dir / "npm.cmd").write_bytes(FAKE_NPM_CMD.replace("\n", "\r\n").encode("ascii"))
        python = tmp_path / "env" / "python.cmd"
        python.parent.mkdir()
        python.write_bytes(FAKE_PYTHON_CMD.replace("\n", "\r\n").encode("ascii"))
        root = os.environ.get("SystemRoot", r"C:\Windows")
        env = {
            "SystemRoot": root,
            "ComSpec": os.environ.get("ComSpec", rf"{root}\System32\cmd.exe"),
            "PATH": rf"{root}\System32;{root}",
            "NVM_SYMLINK": str(node_dir),  # trouvé par la recherche Windows (§9.3), pas par le PATH
        }
        return home, python, env
    node_dir = fake_bin(home / ".homebrew" / "bin", "node")
    (node_dir / "npm").write_text(FAKE_NPM, encoding="utf-8")
    (node_dir / "npm").chmod(0o755)
    python = tmp_path / "env" / "python"
    python.parent.mkdir()
    python.write_text(FAKE_PYTHON, encoding="utf-8")
    python.chmod(0o755)
    return home, python, {"PATH": "/usr/bin:/bin"}


@needs_git
def test_full_update_with_real_processes(tmp_path: Path) -> None:
    """Vrais sous-processus (npm.cmd sous Windows) ; dépôt dans un dossier avec espaces et accents (§9.2)."""
    repo = make_repo(tmp_path / "Mes d\u00e9p\u00f4ts" / "atelier viz")
    home, python, base_env = fake_tools(tmp_path)
    calls, fail = tmp_path / "calls.txt", tmp_path / "fail-build"
    env = {**base_env, "FAKE_CALLS": str(calls), "FAKE_FAIL_BUILD": str(fail)}
    # Interface déjà compilée par l'ancienne version.
    (repo / "frontend" / "dist").mkdir()
    (repo / "frontend" / "dist" / "index.html").write_text("ancienne", encoding="utf-8")
    updater = Updater(
        repo=repo,
        python=str(python),
        log=tmp_path / "logs" / "mise-a-jour.log",
        npm_finder=lambda: launcher.find_npm(env, home, lambda: None),
        git=GIT,
        env=env,
    )
    seen: list[tuple[str, int, int]] = []
    result = updater.run(lambda label, i, n: seen.append((label, i, n)))
    assert result.ok, (result.message, updater.log.read_text(encoding="utf-8"))
    assert [s[1:] for s in seen] == [(1, 3), (2, 3), (3, 3)]
    lines = calls.read_text(encoding="utf-8").splitlines()
    assert lines[0].startswith("python -m pip install") and lines[0].endswith("-r requirements-desktop.txt")
    assert lines[1].startswith("npm ci") and lines[2].startswith("npm run build -- --outDir .dist-next")
    assert "nouvelle" in dist_text(repo)
    # Échec de compilation au lancement suivant : ancienne compilation et tampon conservés.
    (repo / "frontend" / "src" / "main.tsx").write_text("export const v = 9\n", encoding="utf-8")
    commit(repo)
    fail.touch()
    stamp = updater.stamp_path.read_text(encoding="utf-8")
    result = updater.run()
    assert not result.ok and result.failed_step == "build" and result.previous_available
    assert "nouvelle" in dist_text(repo) and updater.stamp_path.read_text(encoding="utf-8") == stamp
    assert "erreur de compilation" in updater.log.read_text(encoding="utf-8")
    assert (repo / "backend" / "data" / "atelier.duckdb").read_bytes() == b"donnees-utilisateur"
