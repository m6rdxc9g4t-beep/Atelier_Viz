#!/usr/bin/env python3
"""Construit le paquet autonome d'Atelier Viz (macOS, Windows ou Linux) avec PyInstaller.

    python scripts/standalone/build.py               # → dist-standalone/ (+ archive à distribuer)
    python scripts/standalone/build.py --self-test   # … puis lance le paquet en auto-test

À lancer avec un Python 3.11+ « propre » (venv) : tout ce qui y est installé peut finir dans le paquet.
Le résultat ne demande ni Python, ni conda, ni Node sur la machine de l'utilisateur.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SPEC = ROOT / "scripts" / "standalone" / "atelier_viz.spec"
DIST = ROOT / "dist-standalone"
WORK = ROOT / "build-standalone"


def say(text: str) -> None:
    print(f"\n== {text}", flush=True)


def run(cmd: list[str], cwd: Path | None = None) -> None:
    print("$", " ".join(cmd), flush=True)
    subprocess.run(cmd, cwd=cwd, check=True, shell=False)  # noqa: S603 — commandes fixes


def npm() -> str:
    exe = shutil.which("npm.cmd" if sys.platform == "win32" else "npm") or shutil.which("npm")
    if not exe:
        sys.exit("npm introuvable : installez Node.js (https://nodejs.org) pour compiler l'interface.")
    return exe


def executable() -> Path:
    """Exécutable produit (dans le paquet)."""
    if sys.platform == "darwin":
        return DIST / "Atelier Viz.app" / "Contents" / "MacOS" / "Atelier Viz"
    if sys.platform == "win32":
        return DIST / "Atelier Viz" / "Atelier Viz.exe"
    return DIST / "atelier-viz" / "atelier-viz"


def archive(version: str) -> Path:
    """Archive à distribuer : .zip (macOS, Windows) ou .tar.gz (Linux)."""
    if sys.platform == "darwin":
        out = DIST / f"Atelier-Viz-{version}-macOS.zip"
        # ditto garde les liens symboliques et les attributs du paquet .app.
        run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(DIST / "Atelier Viz.app"), str(out)])
        return out
    if sys.platform == "win32":
        out = DIST / f"Atelier-Viz-{version}-Windows.zip"
        folder = DIST / "Atelier Viz"
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
            for f in folder.rglob("*"):
                z.write(f, Path("Atelier Viz") / f.relative_to(folder))
        return out
    out = DIST / f"atelier-viz-{version}-linux.tar.gz"
    with tarfile.open(out, "w:gz") as t:
        t.add(DIST / "atelier-viz", arcname="atelier-viz")
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--self-test", action="store_true", help="lancer le paquet en auto-test après la construction")
    parser.add_argument("--skip-install", action="store_true", help="ne pas installer les dépendances (réseau)")
    parser.add_argument("--skip-frontend", action="store_true", help="ne pas recompiler l'interface")
    args = parser.parse_args()
    if sys.version_info < (3, 11):  # noqa: UP036 — script lancé par n'importe quel Python
        sys.exit("Python 3.11 ou plus récent requis.")
    version = (
        (ROOT / "backend" / "app" / "__init__.py").read_text(encoding="utf-8").split('__version__ = "')[1].split('"')[0]
    )

    if not args.skip_install:
        say("1/4 · Dépendances Python")
        backend = ROOT / "backend"
        run(
            [
                sys.executable,
                "-m",
                "pip",
                "install",
                "--disable-pip-version-check",
                "-q",
                "-r",
                str(backend / "requirements.txt"),
                "-r",
                str(backend / "requirements-desktop.txt"),
                "-r",
                str(backend / "requirements-connectors.txt"),
                "pyinstaller>=6.10",
                "pillow>=10",
            ]
        )
    if not args.skip_frontend:
        say("2/4 · Interface (npm ci, npm run build)")
        frontend = ROOT / "frontend"
        run([npm(), "ci", "--no-audit", "--no-fund", "--loglevel=error"], cwd=frontend)
        run([npm(), "run", "build"], cwd=frontend)
    if not (ROOT / "frontend" / "dist" / "index.html").is_file():
        sys.exit("Interface absente (frontend/dist) : lancez sans --skip-frontend.")

    say(f"3/4 · Paquet PyInstaller ({sys.platform}, Atelier Viz {version})")
    shutil.rmtree(DIST, ignore_errors=True)
    run(
        [
            sys.executable,
            "-m",
            "PyInstaller",
            "--noconfirm",
            "--clean",
            "--distpath",
            str(DIST),
            "--workpath",
            str(WORK),
            str(SPEC),
        ]
    )
    exe = executable()
    if not exe.is_file():
        sys.exit(f"Exécutable introuvable : {exe}")
    out = archive(version)
    size = out.stat().st_size / 1e6
    say(f"4/4 · Prêt : {out} ({size:.0f} Mo)")

    if args.self_test:
        say("Auto-test du paquet")
        home = WORK / "self-test-home"
        shutil.rmtree(home, ignore_errors=True)
        env = {**__import__("os").environ, "ATELIER_HOME": str(home)}
        code = subprocess.run([str(exe), "--self-test"], env=env, check=False, timeout=180).returncode  # noqa: S603
        log = home / "atelier-viz.log"
        if log.is_file():
            print(log.read_text(encoding="utf-8", errors="replace"))
        if code != 0:
            sys.exit(f"Auto-test en échec (code {code}).")
        print("Auto-test réussi.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
