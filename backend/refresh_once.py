"""Actualisation des sources quand l'application est fermée (tâche du système). Voir app/background.py.

Lancé par launchd (macOS), le Planificateur de tâches (Windows, `pythonw.exe` : aucune console) ou un
minuteur systemd (Linux), installés depuis Automatisation → « Quand l'application est fermée ».
"""

import os
import sys
from pathlib import Path

if __name__ == "__main__":
    # Dossier du backend comme dossier courant (backend/.env, backend/data), quel que soit le lanceur.
    here = Path(__file__).resolve().parent
    os.chdir(here)
    sys.path.insert(0, str(here))
    from app.background import main

    sys.exit(main())
