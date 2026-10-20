"""Décision du lanceur de « Atelier Viz.app » : faut-il recompiler l'interface avant d'ouvrir la fenêtre ?

Local d'abord : au lancement, **jamais** de `npm install` (réseau, scripts des paquets). Seulement :
- `ok`      : l'interface compilée (frontend/dist) est à jour ;
- `build`   : elle est plus ancienne que ses sources et `node_modules` correspond à `package-lock.json` :
              `npm run build` suffit (hors ligne) ;
- `install` : les dépendances manquent ou ont changé (git pull) : il faut relancer
              `scripts/macos/build_app.sh`, seul à installer les paquets ; l'ancienne interface reste utilisée.

Appelé par le lanceur (`python -m app.launcher <dossier frontend>`), qui affiche l'action sur la sortie standard.
Bibliothèque standard seulement : fonctionne même si des dépendances Python manquent.
"""

import json
import sys
from pathlib import Path
from typing import Any, Literal

Action = Literal["ok", "build", "install"]

SOURCES = ("src", "public", "index.html", "package.json", "package-lock.json", "vite.config.ts", "tsconfig.json")
"""Fichiers et dossiers dont une modification rend l'interface compilée périmée."""


def _read_json(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _newest(path: Path) -> float:
    """Date de modification la plus récente d'un fichier ou d'une arborescence (0 si absent)."""
    if path.is_file():
        return path.stat().st_mtime
    if not path.is_dir():
        return 0.0
    return max((p.stat().st_mtime for p in path.rglob("*") if p.is_file()), default=0.0)


def interface_stale(front: Path) -> bool:
    """Vrai si `dist/index.html` manque ou est plus ancien qu'une de ses sources."""
    dist = front / "dist" / "index.html"
    if not dist.is_file():
        return True
    built = dist.stat().st_mtime
    return any(_newest(front / name) > built for name in SOURCES)


def dependencies_current(front: Path) -> bool:
    """Vrai si `node_modules` correspond à `package-lock.json` (et celui-ci à `package.json`).

    Compare chaque paquet du verrou à `node_modules/.package-lock.json` (écrit par npm à l'installation) :
    même version. Un paquet facultatif absent est normal (binaires d'autres plateformes).
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


def interface_action(front: Path) -> Action:
    """Action du lanceur pour le dossier `frontend` (voir le module)."""
    if not interface_stale(front):
        return "ok"
    return "build" if dependencies_current(front) else "install"


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if len(args) != 1:
        print("usage : python -m app.launcher <dossier frontend>", file=sys.stderr)
        return 2
    print(interface_action(Path(args[0])))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
