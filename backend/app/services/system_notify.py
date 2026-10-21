"""Notifications système : centre de notifications macOS (`osascript`), `notify-send` sous Linux.

Aucun shell : le titre et le message passent en arguments (`on run argv`), jamais dans le script ;
caractères de contrôle retirés, longueur bornée, délai de 5 s. Sans outil disponible (Windows,
serveur sans bureau), `system_notifier()` renvoie None et rien n'est envoyé.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import unicodedata
from collections.abc import Callable

Notifier = Callable[[str, str], None]

_MAC_SCRIPT = ["on run argv", "display notification (item 2 of argv) with title (item 1 of argv)", "end run"]
MAX_TITLE = 80
MAX_MESSAGE = 240


def clean(text: str, limit: int) -> str:
    """Texte sans caractère de contrôle ni de mise en forme invisible, borné à `limit` caractères."""
    kept = "".join(" " if unicodedata.category(c) in {"Cc", "Cf", "Zl", "Zp"} else c for c in text)
    kept = " ".join(kept.split())
    return kept if len(kept) <= limit else kept[: limit - 1] + "…"


def _run(args: list[str]) -> None:
    try:
        subprocess.run(args, check=False, capture_output=True, timeout=5)  # noqa: S603 — exécutable absolu, arguments en liste
    except (OSError, subprocess.SubprocessError):
        pass  # une notification manquée ne doit jamais faire échouer l'alerte


def system_notifier(platform: str | None = None) -> Notifier | None:
    """Fonction d'envoi pour ce système, ou None si aucune n'est disponible."""
    platform = platform or sys.platform
    if platform == "darwin":
        exe = shutil.which("osascript")
        if exe:
            script = [part for line in _MAC_SCRIPT for part in ("-e", line)]
            return lambda title, message: _run([exe, *script, clean(title, MAX_TITLE), clean(message, MAX_MESSAGE)])
    if platform.startswith("linux"):
        exe = shutil.which("notify-send")
        if exe:
            return lambda title, message: _run(
                [exe, "--app-name=Atelier Viz", "--", clean(title, MAX_TITLE), clean(message, MAX_MESSAGE)]
            )
    return None
