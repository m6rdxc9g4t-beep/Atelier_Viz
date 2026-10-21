"""Application autonome (PyInstaller) : Python, dépendances et interface compilée dans un seul paquet.

Aucune installation préalable (ni Python, ni conda, ni Node) : « Atelier Viz.app » (macOS),
« Atelier Viz.exe » (Windows) ou le dossier `atelier-viz` (Linux) se lancent tels quels.

- Les ressources du paquet (interface compilée, exemples) sont lues dans le dossier d'extraction
  (`sys._MEIPASS`) ; elles sont désignées au serveur par les variables `FRONTEND_DIST` et `SAMPLES_DIR`.
- Les données de l'utilisateur vivent hors du paquet, dans le dossier d'application du système
  (`user_dir()`), qui devient aussi le dossier courant : un fichier `.env` y est lu (CLAUDE_MODE…).
  Une mise à jour (remplacer l'application) ne touche donc jamais aux données.
- `--self-test` : démarre le serveur sans fenêtre, vérifie `/api/health`, l'interface et les exemples,
  puis s'arrête (code 0 si tout va bien) ; utilisé par la construction et l'intégration continue.
- Sinon : l'application de bureau habituelle (`app.desktop.run`).
"""

from __future__ import annotations

import os
import sys
from collections.abc import Mapping, MutableMapping
from pathlib import Path

APP_NAME = "Atelier Viz"


def frozen() -> bool:
    """Vrai dans le paquet PyInstaller."""
    return bool(getattr(sys, "frozen", False))


def bundle_dir() -> Path:
    """Ressources du paquet (dossier d'extraction), ou racine du dépôt en développement."""
    meipass = getattr(sys, "_MEIPASS", None)
    return Path(meipass) if meipass else Path(__file__).resolve().parents[2]


def user_dir(platform: str | None = None, env: Mapping[str, str] | None = None, home: Path | None = None) -> Path:
    """Dossier des données de l'utilisateur, selon le système."""
    platform = platform or sys.platform
    env = os.environ if env is None else env
    home = home or Path.home()
    if platform == "darwin":
        return home / "Library" / "Application Support" / APP_NAME
    if platform == "win32":
        base = env.get("LOCALAPPDATA") or str(home / "AppData" / "Local")
        return Path(base) / APP_NAME
    base = env.get("XDG_DATA_HOME") or str(home / ".local" / "share")
    return Path(base) / "atelier-viz"


def configure(
    env: MutableMapping[str, str] | None = None, platform: str | None = None, home: Path | None = None
) -> Path:
    """Variables du serveur pour le paquet (sans écraser celles déjà fixées) ; renvoie le dossier utilisateur."""
    env = os.environ if env is None else env
    folder = Path(env.get("ATELIER_HOME") or user_dir(platform, env, home))
    folder.mkdir(parents=True, exist_ok=True)
    bundle = bundle_dir()
    dist = bundle / "frontend_dist" if (bundle / "frontend_dist").is_dir() else bundle / "frontend" / "dist"
    env.setdefault("DATA_DIR", str(folder / "data"))
    env.setdefault("FRONTEND_DIST", str(dist))
    env.setdefault("SAMPLES_DIR", str(bundle / "samples"))
    env.setdefault("SERVE_FRONTEND", "true")
    return folder


def self_test() -> int:
    """Démarre le serveur sans fenêtre et vérifie l'API, l'interface et les exemples."""
    import json
    import urllib.request

    from app.core.config import get_settings
    from app.desktop import HOST, ServerThread, find_port
    from main import create_app

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    settings = get_settings()
    server = ServerThread(create_app(settings), find_port(0, HOST))
    problems: list[str] = []
    try:
        server.start()
        with opener.open(f"{server.url}/api/health", timeout=10) as r:  # noqa: S310 — adresse locale
            health = json.load(r)
        if health.get("status") != "ok":
            problems.append(f"/api/health : {health}")
        with opener.open(f"{server.url}/", timeout=10) as r:  # noqa: S310
            page = r.read().decode("utf-8", "replace")
        if 'id="root"' not in page:
            problems.append("interface absente (index.html)")
        with opener.open(f"{server.url}/api/samples", timeout=10) as r:  # noqa: S310
            samples = json.load(r)
        if not samples:
            problems.append("exemples absents (samples)")
        print(
            f"{APP_NAME} {health.get('version', '?')} : API, interface et {len(samples)} exemple(s) OK — {server.url}"
        )
    except Exception as exc:  # noqa: BLE001 — tout échec doit donner un code de sortie non nul
        problems.append(f"{type(exc).__name__} : {exc}")
    finally:
        server.stop()
    for p in problems:
        print(f"Auto-test en échec : {p}", file=sys.stderr)
    return 1 if problems else 0


def main(argv: list[str] | None = None) -> int:
    """Point d'entrée du paquet."""
    args = list(sys.argv[1:] if argv is None else argv)
    folder = configure()
    os.chdir(folder)  # `.env` de l'utilisateur, chemins relatifs éventuels
    if frozen() and sys.stdout is None:  # Windows sans console : journal dans le dossier utilisateur
        log = open(folder / "atelier-viz.log", "a", encoding="utf-8")  # noqa: SIM115 — gardé ouvert
        sys.stdout = sys.stderr = log
    if "--self-test" in args:
        return self_test()
    from app.desktop import run

    args = [a for a in args if not a.startswith("-psn_")]  # macOS ajoute -psn_… au premier lancement
    if frozen() and sys.platform.startswith("linux") and "--browser" not in args:
        args.append("--browser")  # paquet Linux sans fenêtre native : navigateur par défaut
    return run(args)
