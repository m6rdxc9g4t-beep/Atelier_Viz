"""Lanceur de « Atelier Viz.app » : jamais de `npm install` au lancement, seulement `npm run build` si possible."""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

from app.launcher import dependencies_current, interface_action, interface_stale, main

ROOT = Path(__file__).resolve().parents[2]


def write_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


def touch(path: Path, mtime: float) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        path.write_text("x", encoding="utf-8")
    os.utime(path, (mtime, mtime))


@pytest.fixture
def front(tmp_path: Path) -> Path:
    """Dossier frontend installé et compilé, à jour."""
    deps = {"dependencies": {"react": "^19.0.0"}, "devDependencies": {"vite": "^7.0.0"}}
    write_json(tmp_path / "package.json", {"name": "f", **deps})
    packages = {
        "": {"name": "f", **deps},
        "node_modules/react": {"version": "19.1.0"},
        "node_modules/vite": {"version": "7.0.1", "dev": True},
        "node_modules/@esbuild/darwin-arm64": {"version": "0.25.0", "optional": True, "dev": True},
        "node_modules/fsevents": {"version": "2.3.3", "devOptional": True},
    }
    write_json(tmp_path / "package-lock.json", {"lockfileVersion": 3, "packages": packages})
    installed = {k: v for k, v in packages.items() if k and "esbuild" not in k and "fsevents" not in k}
    write_json(tmp_path / "node_modules" / ".package-lock.json", {"lockfileVersion": 3, "packages": installed})
    for name in ("package.json", "package-lock.json", "node_modules/.package-lock.json", "src/main.tsx", "index.html"):
        touch(tmp_path / name, 1000.0)
    touch(tmp_path / "dist" / "index.html", 2000.0)
    return tmp_path


def test_up_to_date_interface_needs_nothing(front: Path) -> None:
    assert interface_stale(front) is False
    assert dependencies_current(front) is True  # paquets facultatifs d'autres plateformes : absents, normal
    assert interface_action(front) == "ok"


def test_newer_sources_with_current_dependencies_only_rebuild(front: Path) -> None:
    touch(front / "src" / "App.tsx", 3000.0)
    assert interface_action(front) == "build"


def test_missing_build_with_current_dependencies_rebuilds(front: Path) -> None:
    (front / "dist" / "index.html").unlink()
    assert interface_action(front) == "build"


def test_missing_node_modules_asks_for_build_app(front: Path) -> None:
    touch(front / "src" / "App.tsx", 3000.0)
    (front / "node_modules" / ".package-lock.json").unlink()
    assert interface_action(front) == "install"


def test_changed_lockfile_asks_for_build_app(front: Path) -> None:
    """git pull qui met React à jour : node_modules ne correspond plus, rien n'est installé au lancement."""
    lock = json.loads((front / "package-lock.json").read_text())
    lock["packages"]["node_modules/react"]["version"] = "19.2.0"
    write_json(front / "package-lock.json", lock)
    touch(front / "package-lock.json", 3000.0)
    assert dependencies_current(front) is False
    assert interface_action(front) == "install"


def test_new_required_package_asks_for_build_app(front: Path) -> None:
    lock = json.loads((front / "package-lock.json").read_text())
    lock["packages"]["node_modules/zustand"] = {"version": "5.0.0"}
    write_json(front / "package-lock.json", lock)
    touch(front / "src" / "App.tsx", 3000.0)
    assert interface_action(front) == "install"


def test_package_json_edited_without_install_asks_for_build_app(front: Path) -> None:
    write_json(front / "package.json", {"name": "f", "dependencies": {"react": "^19.0.0", "zustand": "^5.0.0"}})
    touch(front / "package.json", 3000.0)
    assert interface_action(front) == "install"


def test_unreadable_lockfile_is_not_current(front: Path) -> None:
    (front / "node_modules" / ".package-lock.json").write_text("{pas du json", encoding="utf-8")
    assert dependencies_current(front) is False


def test_command_line_prints_the_action(front: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert main([str(front)]) == 0
    assert capsys.readouterr().out.strip() == "ok"
    assert main([]) == 2
    out = subprocess.run(
        [sys.executable, "-m", "app.launcher", str(front)],
        cwd=ROOT / "backend",
        capture_output=True,
        text=True,
        check=True,
    )
    assert out.stdout.strip() == "ok"


def test_generated_launcher_never_runs_npm_install() -> None:
    """Le lanceur écrit par build_app.sh (entre les balises LAUNCHER) n'installe jamais de paquet."""
    script = (ROOT / "scripts" / "macos" / "build_app.sh").read_text(encoding="utf-8")
    launcher = re.search(r"cat <<'LAUNCHER'\n(.*?)\nLAUNCHER\n", script, re.S)
    assert launcher is not None
    body = launcher.group(1)
    code = "\n".join(line for line in body.splitlines() if not line.lstrip().startswith("#"))
    assert "npm install" not in code and "npm ci" not in code and "npm i " not in code
    assert "-m app.launcher" in code and "npm run build" in code
