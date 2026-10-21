"""Point d'entrée du paquet autonome (PyInstaller). Voir app/standalone.py et scripts/standalone/."""

import sys

from app.standalone import main

if __name__ == "__main__":
    sys.exit(main())
