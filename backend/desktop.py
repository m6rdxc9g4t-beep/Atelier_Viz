"""Application de bureau Atelier Viz : serveur local + fenêtre native. Voir app/desktop.py.

Lancée par « Atelier Viz.app » : se met à jour depuis le dépôt avant d'ouvrir l'interface (docs/SUITE.md §8,
`app/launcher.py`) ; `--sans-mise-a-jour` pour s'en passer.
"""

import sys

from app.desktop import run

if __name__ == "__main__":
    sys.exit(run(auto_update=True))
