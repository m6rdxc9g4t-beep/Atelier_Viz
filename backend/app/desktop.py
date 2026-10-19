"""Application de bureau : le serveur local et l'interface dans une fenêtre native.

Lancée par « Atelier Viz.app » (voir scripts/macos/build_app.sh), ou à la main :
    python desktop.py              # fenêtre native (pywebview), sinon navigateur
    python desktop.py --browser    # dans le navigateur par défaut

- Le serveur écoute sur 127.0.0.1 uniquement (jamais sur le réseau), port 8000 s'il est libre.
- Un serveur Atelier Viz déjà lancé (par exemple `uvicorn` en développement) est réutilisé :
  la base DuckDB n'accepte qu'un seul processus à la fois.
- Fermer la fenêtre (ou ⌘Q) arrête le serveur proprement.
- Pont JavaScript (`window.pywebview.api`) : enregistrement de fichiers par une vraie boîte
  « Enregistrer sous » et ouverture des liens externes dans le navigateur.
"""

import argparse
import base64
import binascii
import contextlib
import html
import json
import logging
import signal
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from collections.abc import Callable
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlsplit

import uvicorn

from app.core.config import Settings, get_settings

APP_NAME = "Atelier Viz"
HOST = "127.0.0.1"
PREFERRED_PORT = 8000
WINDOW_SIZE = (1440, 900)
MIN_SIZE = (1024, 640)
ICON = Path(__file__).resolve().parents[2] / "scripts" / "macos" / "icon.png"

log = logging.getLogger("atelier.desktop")

# Requêtes vers le serveur local sans aucun proxy (macOS applique sinon le proxy système de l'entreprise).
_local = urllib.request.build_opener(urllib.request.ProxyHandler({}))


# --- Serveur ----------------------------------------------------------------------------------


def port_free(port: int, host: str = HOST) -> bool:
    """Vrai si personne n'écoute sur ce port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, port))
        except OSError:
            return False
        return True


def find_port(preferred: int = PREFERRED_PORT, host: str = HOST) -> int:
    """Le port préféré s'il est libre, sinon un port libre choisi par le système."""
    if preferred > 0 and port_free(preferred, host):
        return preferred
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind((host, 0))
        port: int = s.getsockname()[1]
        return port


def probe(base_url: str, timeout: float = 0.6) -> dict[str, Any] | None:
    """Réponse de `/api/health` d'un serveur Atelier Viz, ou None."""
    try:
        with _local.open(f"{base_url}/api/health", timeout=timeout) as r:  # noqa: S310 — adresse locale
            data = json.loads(r.read())
    except (OSError, ValueError, urllib.error.URLError):
        return None
    return data if isinstance(data, dict) and data.get("status") == "ok" and "version" in data else None


def serves_interface(base_url: str, timeout: float = 0.6) -> bool:
    """Vrai si le serveur sert aussi l'interface compilée (page d'accueil HTML)."""
    try:
        with _local.open(f"{base_url}/", timeout=timeout) as r:  # noqa: S310 — adresse locale
            return "text/html" in r.headers.get("Content-Type", "") and b'id="root"' in r.read(200_000)
    except (OSError, urllib.error.URLError):
        return False


class ServerThread:
    """Uvicorn dans un fil d'exécution, arrêté proprement (fermeture de DuckDB comprise)."""

    def __init__(self, app: Any, port: int, host: str = HOST) -> None:
        self.url = f"http://{host}:{port}"
        self.server = uvicorn.Server(uvicorn.Config(app, host=host, port=port, log_level="info", access_log=False))
        self.thread = threading.Thread(target=self._run, name="atelier-server", daemon=True)
        self.error: BaseException | None = None

    def _run(self) -> None:
        try:
            self.server.run()
        except BaseException as exc:  # noqa: BLE001 — remonté à `wait_ready`
            self.error = exc

    def start(self, timeout: float = 30.0) -> None:
        """Démarre et attend que l'API réponde ; lève RuntimeError sinon."""
        self.thread.start()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.server.started and probe(self.url):
                return
            if not self.thread.is_alive():
                break
            time.sleep(0.05)
        self.stop()
        reason = f" : {self.error}" if self.error else ""
        raise RuntimeError(f"Le serveur local n'a pas démarré{reason}.")

    def stop(self, timeout: float = 10.0) -> None:
        self.server.should_exit = True
        if self.thread.is_alive():
            self.thread.join(timeout)


def database_busy(settings: Settings) -> str | None:
    """Message si la base DuckDB est déjà ouverte par un autre processus (un seul à la fois)."""
    import duckdb

    path = settings.data_dir / "atelier.duckdb"
    if not path.exists():
        return None
    try:
        duckdb.connect(str(path)).close()
    except duckdb.Error as exc:
        if "lock" in str(exc).lower():
            return (
                "La base de données est déjà ouverte par un autre programme Atelier Viz "
                "(un serveur « uvicorn » lancé dans un terminal ?). Arrêtez-le, puis relancez l'application."
            )
        return f"Base de données illisible : {exc}"
    return None


# --- Pont JavaScript ----------------------------------------------------------------------------


class SaveWindow(Protocol):
    def create_file_dialog(
        self,
        dialog_type: Any,
        directory: str = "",
        allow_multiple: bool = False,
        save_filename: str = "",
        file_types: Any = (),
    ) -> Any: ...


class DesktopApi:
    """Fonctions appelables depuis la page : `window.pywebview.api.<nom>(...)` (promesses)."""

    def __init__(self, open_url: Callable[[str], Any] = webbrowser.open) -> None:
        self.window: SaveWindow | None = None
        self.save_dialog: Any = None  # webview.FileDialog.SAVE, renseigné au lancement
        self._open_url = open_url

    def save_file(self, name: str, data_base64: str) -> dict[str, Any]:
        """Boîte « Enregistrer sous » puis écriture du fichier ; {"saved": chemin | None}."""
        if self.window is None:
            return {"saved": None, "error": "Fenêtre indisponible."}
        safe = Path(str(name)).name or "export"
        try:
            content = base64.b64decode(data_base64, validate=True)
        except (binascii.Error, ValueError):
            return {"saved": None, "error": "Contenu du fichier invalide."}
        result = self.window.create_file_dialog(
            self.save_dialog, directory=str(Path.home() / "Downloads"), save_filename=safe
        )
        if not result:
            return {"saved": None}
        target = Path(result if isinstance(result, str) else result[0])
        try:
            target.write_bytes(content)
        except OSError as exc:
            return {"saved": None, "error": f"Écriture impossible : {exc}"}
        return {"saved": str(target)}

    def open_external(self, url: str) -> bool:
        """Ouvre un lien http(s) ou mailto dans le navigateur par défaut (jamais un fichier local)."""
        if urlsplit(str(url)).scheme not in {"http", "https", "mailto"}:
            return False
        self._open_url(str(url))
        return True


# --- Lancement ----------------------------------------------------------------------------------


_PAGE_STYLE = (
    "font:15px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:90vh;margin:0;color:#1f2328"
)
_LOG_HINT = "Journal : ~/Library/Logs/Atelier Viz/atelier-viz.log"


def error_page(message: str) -> str:
    """Page affichée dans la fenêtre quand le démarrage échoue."""
    return (
        f'<!doctype html><meta charset="utf-8"><title>{APP_NAME}</title>'
        f'<body style="{_PAGE_STYLE}"><div style="max-width:34rem;padding:2rem">'
        f'<h1 style="font-size:18px">{APP_NAME} ne peut pas démarrer</h1><p>{html.escape(message)}</p>'
        f'<p style="color:#656d76;font-size:13px">{_LOG_HINT}</p></div>'
    )


def _name_macos_app() -> None:
    """Nom « Atelier Viz » dans la barre des menus (au lieu de « Python »), avant d'importer pywebview."""
    if sys.platform != "darwin":
        return
    with contextlib.suppress(Exception):
        from Foundation import NSBundle  # type: ignore[import-not-found]

        bundle = NSBundle.mainBundle()
        info = bundle.localizedInfoDictionary() or bundle.infoDictionary()
        if info is not None:
            info["CFBundleName"] = APP_NAME


def prepare(settings: Settings) -> tuple[str, ServerThread | None, str | None]:
    """(adresse, serveur démarré par nous ou None, message d'erreur éventuel)."""
    existing = f"http://{HOST}:{PREFERRED_PORT}"
    if probe(existing):
        if serves_interface(existing):
            log.info("Serveur déjà lancé sur %s : réutilisé.", existing)
            return existing, None, None
        return (
            existing,
            None,
            (
                "Un serveur Atelier Viz de développement tourne déjà sur le port 8000, sans l'interface compilée. "
                "Arrêtez-le (Ctrl+C dans son terminal) puis relancez l'application."
            ),
        )
    if not (settings.frontend_dist / "index.html").is_file():
        return "", None, f"Interface introuvable ({settings.frontend_dist}). Relancez scripts/macos/build_app.sh."
    busy = database_busy(settings)
    if busy:
        return "", None, busy
    from main import create_app

    server = ServerThread(create_app(settings), find_port(PREFERRED_PORT))
    try:
        server.start()
    except RuntimeError as exc:
        return "", None, str(exc)
    log.info("Serveur démarré sur %s", server.url)
    return server.url, server, None


def _interrupt(*_: object) -> None:
    raise KeyboardInterrupt


def run(argv: list[str] | None = None) -> int:
    """Point d'entrée de l'application de bureau."""
    parser = argparse.ArgumentParser(description=f"{APP_NAME} — application de bureau")
    parser.add_argument("--browser", action="store_true", help="ouvrir dans le navigateur au lieu d'une fenêtre")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s : %(message)s")

    settings = get_settings()
    url, server, error = prepare(settings)
    webview: Any = None
    if not args.browser:
        _name_macos_app()
        try:
            import webview  # type: ignore[import-not-found,no-redef]
        except ImportError:
            log.warning("pywebview absent : navigateur utilisé (pip install -r requirements-desktop.txt).")

    try:
        if webview is None:
            if error:
                log.error(error)
                print(error, file=sys.stderr)
                return 1
            webbrowser.open(url)
            if server is None:
                return 0
            print(f"{APP_NAME} : {url} — Ctrl+C pour arrêter.")
            signal.signal(signal.SIGTERM, _interrupt)  # « Quitter » depuis le Dock : arrêt propre
            with contextlib.suppress(KeyboardInterrupt):
                while server.thread.is_alive():
                    time.sleep(0.5)
            return 0

        api = DesktopApi()
        api.save_dialog = webview.FileDialog.SAVE
        webview.settings["ALLOW_DOWNLOADS"] = True
        webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True
        window = webview.create_window(
            APP_NAME,
            url=None if error else url,
            html=error_page(error) if error else None,
            js_api=api,
            width=WINDOW_SIZE[0],
            height=WINDOW_SIZE[1],
            min_size=MIN_SIZE,
            text_select=True,
            zoomable=True,
        )
        api.window = window
        storage = settings.data_dir.resolve() / "webview"
        storage.mkdir(parents=True, exist_ok=True)
        # Stockage persistant : thème, options d'export… conservés d'un lancement à l'autre.
        webview.start(private_mode=False, storage_path=str(storage), icon=str(ICON) if ICON.is_file() else None)
        return 1 if error else 0
    finally:
        if server is not None:
            log.info("Arrêt du serveur.")
            server.stop()
