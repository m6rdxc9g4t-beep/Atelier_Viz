"""Écriture de fichiers sûre sur tous les systèmes (macOS, Linux, Windows).

Sous Windows, remplacer un fichier échoue (`PermissionError`, WinError 5 / 32) tant qu'un autre
programme le tient ouvert : une lecture concurrente de l'API, l'antivirus ou l'indexation qui
l'inspecte juste après son écriture. Ces verrous durent quelques millisecondes : on réessaie
brièvement avant d'abandonner. Sous macOS et Linux, le premier essai réussit toujours.
"""

import os
import sys
import time
from collections.abc import Callable

REPLACE_ATTEMPTS = 20
"""Nombre d'essais de remplacement sous Windows (≈ 1 s au total)."""
REPLACE_PAUSE_SECONDS = 0.05


def replace_file(
    source: str | os.PathLike[str],
    target: str | os.PathLike[str],
    *,
    attempts: int | None = None,
    pause: float = REPLACE_PAUSE_SECONDS,
    replace: Callable[[str | os.PathLike[str], str | os.PathLike[str]], None] = os.replace,
    sleep: Callable[[float], None] = time.sleep,
) -> None:
    """Remplace atomiquement `target` par `source` (comme `os.replace`).

    Sous Windows, un `PermissionError` passager (fichier tenu ouvert un instant par un autre
    programme) est réessayé `attempts` fois, à `pause` secondes d'intervalle ; l'erreur finale
    est relancée telle quelle. Ailleurs, un seul essai.
    """
    tries = attempts if attempts is not None else (REPLACE_ATTEMPTS if sys.platform == "win32" else 1)
    for attempt in range(max(1, tries)):
        try:
            replace(source, target)
            return
        except PermissionError:
            if attempt + 1 >= tries:
                raise
            sleep(pause)
