"""Application de bureau Atelier Viz : serveur local + fenêtre native. Voir app/desktop.py.

Lancée par « Atelier Viz.app » (macOS) ou par le raccourci « Atelier Viz » (Windows : `pythonw.exe desktop.py`) :
se met à jour depuis le dépôt avant d'ouvrir l'interface (docs/SUITE.md §8 et §9, `app/launcher.py`) ;
`--sans-mise-a-jour` pour s'en passer, `--mise-a-jour-seule` pour la mise à jour sans fenêtre (code de sortie).
"""

import os
import sys
from pathlib import Path

from app.desktop import run

if __name__ == "__main__":
    # Dossier du backend comme dossier courant (backend/.env, backend/data), quel que soit le lanceur.
    os.chdir(Path(__file__).resolve().parent)
    sys.exit(run(auto_update=True))
