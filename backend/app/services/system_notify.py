"""Notifications système : centre de notifications macOS (`osascript`), `notify-send` sous Linux,
notification Windows (« toast », Windows PowerShell 5.1 livré avec Windows 10 / 11).

Aucun shell : le titre et le message passent en arguments (`on run argv`) ou, sous Windows, en variables
d'environnement lues par un script **constant** (`-EncodedCommand`, jamais construit avec du texte) ;
caractères de contrôle retirés, longueur bornée, délai de 5 s (10 s sous Windows : PowerShell démarre
lentement). Sans outil disponible (serveur sans bureau), `system_notifier()` renvoie None et rien n'est envoyé.
"""

from __future__ import annotations

import base64
import os
import shutil
import subprocess
import sys
import unicodedata
from collections.abc import Callable

Notifier = Callable[[str, str], None]

_MAC_SCRIPT = ["on run argv", "display notification (item 2 of argv) with title (item 1 of argv)", "end run"]
_WINDOWS_SCRIPT = "\n".join(
    [
        "$ErrorActionPreference = 'Stop'",
        "[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications,"
        " ContentType = WindowsRuntime]",
        "[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]",
        "$kind = [Windows.UI.Notifications.ToastTemplateType]::ToastText02",
        "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($kind)",
        "$texts = $xml.GetElementsByTagName('text')",
        "[void]$texts.Item(0).AppendChild($xml.CreateTextNode($env:ATELIER_NOTIFY_TITLE))",
        "[void]$texts.Item(1).AppendChild($xml.CreateTextNode($env:ATELIER_NOTIFY_MESSAGE))",
        "$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)",
        "$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
        "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show($toast)",
    ]
)
"""Script PowerShell constant : le texte arrive par `ATELIER_NOTIFY_TITLE` / `_MESSAGE`, jamais dans le code.
`CreateTextNode` échappe le XML. Identifiant d'application : celui de Windows PowerShell (toujours inscrit)."""
CREATE_NO_WINDOW = 0x08000000
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


def windows_powershell(environ: dict[str, str] | None = None) -> str | None:
    """Chemin absolu de Windows PowerShell 5.1 (`System32`), jamais cherché dans le `PATH`."""
    env = os.environ if environ is None else environ
    root = env.get("SYSTEMROOT") or env.get("SystemRoot") or env.get("WINDIR")
    if not root:
        return None
    exe = os.path.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    return exe if os.path.isfile(exe) else None


def windows_toast_command(exe: str) -> list[str]:
    """Ligne de commande (constante) de la notification Windows."""
    encoded = base64.b64encode(_WINDOWS_SCRIPT.encode("utf-16-le")).decode("ascii")
    return [exe, "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-EncodedCommand", encoded]


def _windows_toast(exe: str, title: str, message: str) -> None:
    env = {
        **os.environ,
        "ATELIER_NOTIFY_TITLE": clean(title, MAX_TITLE),
        "ATELIER_NOTIFY_MESSAGE": clean(message, MAX_MESSAGE),
    }
    try:
        subprocess.run(  # noqa: S603 — exécutable système absolu, script constant
            windows_toast_command(exe),
            check=False,
            capture_output=True,
            timeout=10,
            env=env,
            creationflags=CREATE_NO_WINDOW,
        )
    except (OSError, subprocess.SubprocessError):
        pass


def system_notifier(platform: str | None = None) -> Notifier | None:
    """Fonction d'envoi pour ce système, ou None si aucune n'est disponible."""
    platform = platform or sys.platform
    if platform == "darwin":
        exe = shutil.which("osascript")
        if exe:
            script = [part for line in _MAC_SCRIPT for part in ("-e", line)]
            return lambda title, message: _run([exe, *script, clean(title, MAX_TITLE), clean(message, MAX_MESSAGE)])
    if platform == "win32":
        exe = windows_powershell()
        if exe:
            return lambda title, message: _windows_toast(exe, title, message)
    if platform.startswith("linux"):
        exe = shutil.which("notify-send")
        if exe:
            return lambda title, message: _run(
                [exe, "--app-name=Atelier Viz", "--", clean(title, MAX_TITLE), clean(message, MAX_MESSAGE)]
            )
    return None
