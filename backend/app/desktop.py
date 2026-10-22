"""Application de bureau : le serveur local et l'interface dans une fenêtre native.

Lancée par « Atelier Viz.app » (macOS, scripts/macos/build_app.sh), par le raccourci « Atelier Viz » du menu
Démarrer (Windows, scripts/windows/install.ps1 : `pythonw.exe desktop.py`, sans console), ou à la main :
    python desktop.py                       # fenêtre native (pywebview), sinon navigateur
    python desktop.py --browser             # dans le navigateur par défaut
    python desktop.py --mise-a-jour-seule   # mise à jour depuis le dépôt puis arrêt (code de sortie), sans fenêtre

- Le serveur écoute sur 127.0.0.1 uniquement (jamais sur le réseau), port 8000 s'il est libre.
- Un serveur Atelier Viz déjà lancé (par exemple `uvicorn` en développement) est réutilisé :
  la base DuckDB n'accepte qu'un seul processus à la fois.
- Fermer la fenêtre (ou ⌘Q) arrête le serveur proprement.
- Pont JavaScript (`window.pywebview.api`) : enregistrement de fichiers par une vraie boîte
  « Enregistrer sous » et ouverture des liens externes dans le navigateur (une autre app de la suite installée
  s'ouvre elle-même, avec un environnement minimal : app/suite_apps.py, docs/SUITE.md §9.4).
- Sans console (`pythonw.exe` sous Windows), la sortie va dans `atelier-viz.log` du dossier des journaux.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import contextlib
import html
import json
import logging
import os
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
from typing import TYPE_CHECKING, Any, Literal, Protocol
from urllib.parse import urlsplit

from app import launcher
from app.suite_apps import open_macos_app, open_suite_app

__all__ = ["open_macos_app", "open_suite_app"]  # réexportés (anciens appels)

if TYPE_CHECKING:
    from app.core.config import Settings

# Dépendances (uvicorn, pydantic, FastAPI…) importées seulement après la mise à jour : l'étape `pip` peut les
# installer ou les changer, et un module déjà chargé ne le serait pas de nouveau (docs/SUITE.md §8).

APP_NAME = "Atelier Viz"
HOST = "127.0.0.1"
PREFERRED_PORT = 8000
WINDOW_SIZE = (1440, 900)
MIN_SIZE = (1024, 640)
ICON = Path(__file__).resolve().parents[2] / "scripts" / "macos" / "icon.png"
WINDOWS_ICON = Path(__file__).resolve().parents[2] / "scripts" / "windows" / "atelier-viz.ico"
APP_LOG_NAME = "atelier-viz.log"

log = logging.getLogger("atelier.desktop")

# Requêtes vers le serveur local sans aucun proxy (macOS applique sinon le proxy système de l'entreprise).
_local = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def get_settings() -> Settings:
    """Réglages du serveur (importés à la demande : voir l'en-tête des imports)."""
    from app.core.config import get_settings as load

    return load()


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
        import uvicorn

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


# Applications de la Suite Atelier (docs/SUITE.md §3) : port de l'interface → identifiant de l'app macOS.
SUITE_BUNDLES = {8000: "fr.atelier-viz.app", 4175: "fr.atelier.tab", 4174: "local.atelier-projets.desktop"}
# Applications en ligne de la suite : hôte exact (https, port par défaut) → identifiant de l'app macOS.
# Atelier Cuisine : PWA sur Vercel, app Mac (Tauri) si installée. Jamais sondée ni contactée par Viz.
SUITE_ONLINE_BUNDLES = {"atelier-cuisine-iota.vercel.app": "fr.ateliercuisine.app"}
_LOCAL_HOSTS = {"127.0.0.1", "localhost"}


def suite_bundle_for(url: str) -> str | None:
    """Identifiant de l'application de bureau à ouvrir pour une adresse de la suite, sinon None.

    Apps locales : hôte de bouclage et port connu. Apps en ligne (Atelier Cuisine) : https, hôte exact,
    port par défaut, sans identifiants.
    """
    try:
        parts = urlsplit(str(url))
        port = parts.port
    except ValueError:
        return None
    if parts.scheme not in {"http", "https"} or parts.username is not None or parts.password is not None:
        return None
    if parts.hostname in _LOCAL_HOSTS:
        return SUITE_BUNDLES.get(port) if port is not None else None
    if parts.scheme != "https" or port not in {None, 443} or parts.hostname is None:
        return None
    return SUITE_ONLINE_BUNDLES.get(parts.hostname)


class DesktopApi:
    """Fonctions appelables depuis la page : `window.pywebview.api.<nom>(...)` (promesses)."""

    def __init__(
        self,
        open_url: Callable[[str], Any] = webbrowser.open,
        open_app: Callable[[str], bool] = open_suite_app,
    ) -> None:
        self.window: SaveWindow | None = None
        self.save_dialog: Any = None  # webview.FileDialog.SAVE, renseigné au lancement
        # Écran « Mise à jour… » (docs/SUITE.md §8). Privé : pywebview n'expose pas à la page les noms en « _ ».
        self._update: UpdateSession | None = None
        self._open_url = open_url
        self._open_app = open_app

    def update_state(self) -> dict[str, Any]:
        """État de la mise à jour, lu par l'écran de démarrage (interrogé périodiquement)."""
        return self._update.snapshot() if self._update else {"state": "done"}

    def update_choice(self, choice: str) -> bool:
        """Choix après un échec : « previous » (ouvrir avec la version précédente) ou « quit »."""
        return self._update.choose(choice) if self._update else False

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
        """Ouvre un lien http(s) ou mailto dans le navigateur par défaut (jamais un fichier local).

        L'adresse d'une autre app de la Suite Atelier ouvre son application de bureau quand elle est
        installée (docs/SUITE.md §3 ; macOS `open -b`, Windows lanceur enregistré, §9.4), sinon le navigateur.
        """
        if urlsplit(str(url)).scheme not in {"http", "https", "mailto"}:
            return False
        bundle = suite_bundle_for(url)
        if bundle and self._open_app(bundle):
            return True
        self._open_url(str(url))
        return True


# --- Lancement ----------------------------------------------------------------------------------


_PAGE_STYLE = (
    "font:15px -apple-system,system-ui,sans-serif;display:grid;place-items:center;height:90vh;margin:0;color:#1f2328"
)


def app_log_file(platform: str | None = None, home: Path | None = None) -> Path:
    """Journal de l'application de bureau (`atelier-viz.log`) dans le dossier des journaux du système (§9.2)."""
    return launcher.logs_dir(platform, home) / APP_LOG_NAME


def _shown_path(path: Path, home: Path | None = None) -> str:
    """Chemin affiché : `~/…` sous macOS et Linux quand il est dans le dossier personnel."""
    home = home or Path.home()
    if sys.platform != "win32":
        with contextlib.suppress(ValueError):
            return "~/" + path.relative_to(home).as_posix()
    return str(path)


def error_page(message: str) -> str:
    """Page affichée dans la fenêtre quand le démarrage échoue."""
    hint = html.escape(f"Journal : {_shown_path(app_log_file())}")
    return (
        f'<!doctype html><meta charset="utf-8"><title>{APP_NAME}</title>'
        f'<body style="{_PAGE_STYLE}"><div style="max-width:34rem;padding:2rem">'
        f'<h1 style="font-size:18px">{APP_NAME} ne peut pas démarrer</h1><p>{html.escape(message)}</p>'
        f'<p style="color:#656d76;font-size:13px">{hint}</p></div>'
    )


def ensure_log_streams(path: Path | None = None) -> Path | None:
    """Sans console (`pythonw.exe` sous Windows : `sys.stdout` vaut None), sortie dans `atelier-viz.log`.

    L'ancien journal est gardé une fois (`atelier-viz.log.1`) au-delà de 5 Mo, comme le lanceur macOS.
    Renvoie le journal ouvert, ou None si les sorties existent déjà (terminal, lanceur macOS qui redirige).
    """
    if sys.stdout is not None and sys.stderr is not None:
        return None
    path = path or app_log_file()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with contextlib.suppress(OSError):
            if path.stat().st_size > launcher.ROTATE_LOG_BYTES:
                os.replace(path, path.with_name(path.name + ".1"))
        stream = open(path, "a", encoding="utf-8", errors="replace", buffering=1)  # noqa: SIM115 — gardé ouvert
    except OSError:
        return None
    if sys.stdout is None:
        sys.stdout = stream
    if sys.stderr is None:
        sys.stderr = stream
    print(f"--- {time.strftime('%Y-%m-%d %H:%M:%S')} : lancement", flush=True)
    return path


# --- Mise à jour au lancement (docs/SUITE.md §8) ------------------------------------------------

UpdateChoice = Literal["previous", "quit"]


class UpdateSession:
    """État de la mise à jour partagé entre le fil qui la fait et l'écran de démarrage (sûr entre fils)."""

    def __init__(self, log_file: str = "") -> None:
        self._lock = threading.Lock()
        self._chosen = threading.Event()
        self._choice: UpdateChoice = "quit"
        self._state: dict[str, Any] = {
            "state": "running",
            "label": "Préparation de la mise à jour…",
            "index": 0,
            "total": 0,
            "message": None,
            "log": log_file,
            "can_open_previous": False,
        }

    def snapshot(self) -> dict[str, Any]:
        """Copie de l'état : `state` = running | failed | done."""
        with self._lock:
            return dict(self._state)

    def status(self, label: str, index: int, total: int) -> None:
        """Étape en cours (rappel de `Updater.run`)."""
        with self._lock:
            self._state.update(label=label, index=index, total=total)

    def fail(self, message: str, log_file: str, can_open_previous: bool) -> None:
        with self._lock:
            self._state.update(state="failed", message=message, log=log_file, can_open_previous=can_open_previous)

    def done(self) -> None:
        with self._lock:
            self._state.update(state="done", label="Ouverture…")

    def choose(self, choice: str) -> bool:
        """Choix de l'utilisateur après un échec ; faux si la mise à jour n'a pas échoué ou si le choix est inconnu."""
        with self._lock:
            if self._state["state"] != "failed" or choice not in ("previous", "quit"):
                return False
            if choice == "previous" and not self._state["can_open_previous"]:
                return False
            self._choice = "previous" if choice == "previous" else "quit"
        self._chosen.set()
        return True

    def close(self) -> None:
        """Fenêtre fermée : toute attente de choix se termine par « quit »."""
        with self._lock:
            self._choice = "quit"
        self._chosen.set()

    def wait_choice(self, timeout: float | None = None) -> UpdateChoice:
        """Attend le choix de l'utilisateur (« quit » si la fenêtre est fermée ou le délai dépassé)."""
        self._chosen.wait(timeout)
        with self._lock:
            return self._choice


class PresetResult:
    """Mise à jour déjà tentée (Windows : `pip` avant la fenêtre) : `run` rend son échec sans rien relancer."""

    def __init__(self, updater: launcher.Updater, result: launcher.UpdateResult) -> None:
        self.updater = updater
        self.result = result
        self.log = updater.log

    def previous_available(self) -> bool:
        return self.updater.previous_available()

    def run(self, on_status: launcher.StatusCallback = lambda label, index, total: None) -> launcher.UpdateResult:
        return self.result


def pip_before_window(steps: tuple[launcher.Step, ...], platform: str | None = None) -> bool:
    """Windows : l'étape `pip` se fait avant l'ouverture de la fenêtre.

    La fenêtre charge des bibliothèques de l'environnement Python (pywebview, pythonnet, cffi) ; Windows interdit de
    remplacer un fichier chargé : pip ne pourrait pas les mettre à jour pendant que l'écran « Mise à jour… »
    s'affiche (docs/SUITE.md §9.3).
    """
    return (platform or sys.platform) == "win32" and "pip" in steps


def python_first(
    updater: launcher.Updater, progress: Callable[[Callable[[launcher.StatusCallback], Any]], Any] | None = None
) -> launcher.UpdateResult | None:
    """Fait l'étape `pip` seule (petite fenêtre Tk « Mise à jour… » si possible) ; l'échec éventuel, sinon None."""

    def task(status: launcher.StatusCallback) -> launcher.UpdateResult:
        try:
            return updater.run(status, only=("pip",))
        except Exception as exc:  # noqa: BLE001 — affiché ensuite dans l'écran de démarrage
            log.exception("Mise à jour des dépendances Python impossible")
            return launcher.UpdateResult(
                ok=False,
                failed_step="pip",
                message=f"Mise à jour impossible : {exc}",
                previous_available=updater.previous_available(),
                log=str(updater.log),
            )

    result: launcher.UpdateResult = (progress or tk_progress)(task)
    return None if result.ok else result


def tk_progress(task: Callable[[launcher.StatusCallback], Any], title: str = APP_NAME) -> Any:
    """Exécute `task(status)` dans un fil pendant qu'une petite fenêtre Tk affiche l'étape ; sans Tk, sans fenêtre.

    Tk (bibliothèque standard) ne charge rien de l'environnement Python que pip pourrait remplacer.
    """
    try:
        import tkinter as tk

        root = tk.Tk()
    except Exception:  # noqa: BLE001 — Tk absent ou sans affichage : la mise à jour se fait quand même
        return task(lambda label, index, total: None)
    state: dict[str, Any] = {"label": "Préparation de la mise à jour…", "done": False}

    def status(label: str, index: int, total: int) -> None:
        state["label"] = f"{label}  ({index}/{total})" if total else label

    def work() -> None:
        try:
            state["result"] = task(status)
        except BaseException as exc:  # noqa: BLE001 — relancée dans le fil principal
            state["error"] = exc
        finally:
            state["done"] = True

    try:
        root.title(title)
        root.resizable(False, False)
        root.protocol("WM_DELETE_WINDOW", lambda: None)  # la mise à jour continue : pas de fermeture à moitié
        frame = tk.Frame(root, padx=28, pady=22)
        frame.pack()
        tk.Label(frame, text=f"Mise à jour d'{title}…", font=("Segoe UI", 12, "bold")).pack(anchor="w")
        text = tk.StringVar(value=state["label"])
        tk.Label(frame, textvariable=text, width=58, anchor="w", justify="left").pack(anchor="w", pady=(8, 0))
        root.update_idletasks()
        x = (root.winfo_screenwidth() - root.winfo_width()) // 2
        y = (root.winfo_screenheight() - root.winfo_height()) // 3
        root.geometry(f"+{max(0, x)}+{max(0, y)}")
        worker = threading.Thread(target=work, name="atelier-update-python", daemon=True)
        worker.start()

        def poll() -> None:
            text.set(state["label"])
            if state["done"]:
                root.quit()
            else:
                root.after(200, poll)

        root.after(200, poll)
        root.mainloop()
        worker.join()
    finally:
        with contextlib.suppress(Exception):
            root.destroy()
    if "error" in state:
        raise state["error"]
    return state["result"]


def run_update(
    updater: launcher.Updater,
    session: UpdateSession,
    *,
    offline: bool,
    ask: Callable[[UpdateSession], UpdateChoice] = lambda s: s.wait_choice(),
    on_status: launcher.StatusCallback | None = None,
) -> bool:
    """Fait la mise à jour ; vrai si l'application peut s'ouvrir (à jour, ou avec la version précédente).

    Échec : message dans l'écran de démarrage, journal, et « Ouvrir quand même avec la version précédente » si une
    interface compilée existe. Hors ligne (`online_mode` faux), un échec d'installation (registres de paquets
    injoignables) ouvre directement la version précédente : la mise à jour sera retentée au prochain lancement.
    """

    def status(label: str, index: int, total: int) -> None:
        session.status(label, index, total)
        if on_status is not None:
            on_status(label, index, total)

    try:
        result = updater.run(status)
    except Exception as exc:  # noqa: BLE001 — toute erreur doit laisser l'utilisateur choisir
        log.exception("Mise à jour impossible")
        result = launcher.UpdateResult(
            ok=False,
            message=f"Mise à jour impossible : {exc}",
            previous_available=updater.previous_available(),
            log=str(updater.log),
        )
    if result.ok:
        session.done()
        return True
    log.warning("Mise à jour en échec : %s (journal : %s)", result.message, result.log)
    if offline and result.network and result.previous_available:
        log.info("Mode hors ligne : ouverture avec la version précédente, nouvel essai au prochain lancement.")
        session.done()
        return True
    session.fail(result.message or "La mise à jour a échoué.", result.log, result.previous_available)
    return ask(session) == "previous"


_SPLASH = """<!doctype html><html lang="fr"><meta charset="utf-8"><title>__APP__</title>
<style>
:root{--bg:#fafaf7;--fg:#1f2328;--muted:#656d76;--line:#e4e2da;--accent:#f2c811;--ink:#7a6200;--danger:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#ececec;--muted:#a0a0a0;--line:#2c2c2c;--ink:#f2c811;
--danger:#ff8a80}}
body{font:15px -apple-system,system-ui,sans-serif;background:var(--bg);color:var(--fg);margin:0;height:100vh;
display:grid;place-items:center}
main{max-width:34rem;padding:2rem}h1{font-size:18px;margin:0 0 .75rem}p{line-height:1.5;margin:.5rem 0}
.muted{color:var(--muted);font-size:13px}.err{color:var(--danger)}
.spin{width:22px;height:22px;border:3px solid var(--line);border-top-color:var(--accent);border-radius:50%;
animation:r 1s linear infinite;margin-bottom:1rem}@keyframes r{to{transform:rotate(360deg)}}
button{font:inherit;padding:.5rem .9rem;border-radius:8px;border:1px solid var(--line);background:transparent;
color:var(--fg);cursor:pointer;margin:.75rem .5rem 0 0}
button.primary{background:var(--accent);border-color:var(--accent);color:#1f2328}
[hidden]{display:none!important}
</style>
<main>
<div class="spin" id="spin"></div>
<h1 id="title">Mise à jour d'__APP__…</h1>
<p id="label">Préparation de la mise à jour…</p>
<p class="muted" id="count"></p>
<div id="failed" hidden>
<p class="err" id="message"></p>
<p class="muted">Journal : <span id="log"></span></p>
<p class="muted">La mise à jour sera retentée au prochain lancement.</p>
<button class="primary" id="previous" hidden>Ouvrir quand même avec la version précédente</button>
<button id="quit">Quitter</button>
</div>
</main>
<script>
const $ = (id) => document.getElementById(id);
let busy = false;
async function poll() {
  const api = window.pywebview && window.pywebview.api;
  if (api && !busy) {
    busy = true;
    try {
      const s = await api.update_state();
      $("label").textContent = s.label || "";
      $("count").textContent = s.total ? `Étape ${s.index} sur ${s.total}` : "";
      if (s.state === "failed") {
        $("spin").hidden = true;
        $("title").textContent = "La mise à jour a échoué";
        $("message").textContent = s.message || "";
        $("log").textContent = s.log || "";
        $("previous").hidden = !s.can_open_previous;
        $("failed").hidden = false;
        $("label").hidden = true;
        $("count").hidden = true;
        return;
      }
    } catch (e) { /* pont pas encore prêt */ }
    busy = false;
  }
  setTimeout(poll, 400);
}
function choose(choice) {
  document.querySelectorAll("button").forEach((b) => (b.disabled = true));
  if (choice === "previous") {
    $("failed").hidden = true;
    $("spin").hidden = false;
    $("title").textContent = "Ouverture…";
  }
  window.pywebview.api.update_choice(choice);
}
$("previous").addEventListener("click", () => choose("previous"));
$("quit").addEventListener("click", () => choose("quit"));
poll();
</script></html>"""


def splash_page() -> str:
    """Écran de démarrage « Mise à jour… » : interroge `update_state` et affiche l'étape en cours ou l'échec.

    Aucun contenu inséré côté serveur (hors le nom de l'application) : les textes sont posés par `textContent`.
    """
    return _SPLASH.replace("__APP__", html.escape(APP_NAME))


def update_wanted(auto_update: bool, skip_flag: bool, frozen: bool | None = None) -> bool:
    """Vrai si la mise à jour doit être vérifiée : application lancée depuis le dépôt, jamais le paquet autonome."""
    frozen = bool(getattr(sys, "frozen", False)) if frozen is None else frozen
    return auto_update and not skip_flag and not frozen


def update_only(updater_factory: Callable[[], launcher.Updater], frozen: bool | None = None) -> int:
    """`--mise-a-jour-seule` : mise à jour depuis le dépôt sans fenêtre ni serveur, puis arrêt.

    Code 0 : à jour (rien à faire ou mise à jour réussie) ; 1 : échec (journal `mise-a-jour.log`). Sert à
    l'intégration continue (docs/SUITE.md §9.5) et aux vérifications à la main.
    """
    frozen = bool(getattr(sys, "frozen", False)) if frozen is None else frozen
    if frozen:
        print("Le paquet autonome ne se met pas à jour depuis un dépôt.")
        return 0
    updater = updater_factory()
    result = updater.run(lambda label, i, n: print(f"{i}/{n} · {label}" if n else label, flush=True))
    if result.ok:
        print("Application à jour." if result.steps else "Rien à mettre à jour.", flush=True)
        return 0
    print(f"Mise à jour en échec : {result.message}\nJournal : {result.log}", file=sys.stderr, flush=True)
    return 1


def _console_update(updater: launcher.Updater, offline: bool) -> bool:
    """Mise à jour sans fenêtre (mode navigateur) : étapes et erreurs sur la sortie standard."""
    session = UpdateSession(str(updater.log))

    def status(label: str, index: int, total: int) -> None:
        print(f"{index}/{total} · {label}" if total else label, flush=True)

    def ask(s: UpdateSession) -> UpdateChoice:
        state = s.snapshot()
        print(f"Mise à jour en échec : {state['message']}\nJournal : {state['log']}", file=sys.stderr)
        return "previous" if state["can_open_previous"] else "quit"

    return run_update(updater, session, offline=offline, ask=ask, on_status=status)


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
        return (
            "",
            None,
            f"Interface introuvable ({settings.frontend_dist}). Relancez l'application pour la compiler "
            "(mise à jour automatique), ou scripts/macos/build_app.sh.",
        )
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


def versioned_url(url: str, dist: Path) -> str:
    """Adresse de l'interface marquée de la version compilée (date de frontend/dist/index.html).

    La fenêtre garde un cache persistant : une adresse qui change à chaque compilation garantit
    qu'une mise à jour s'affiche, même si une ancienne page est restée en cache.
    """
    try:
        version = int((dist / "index.html").stat().st_mtime)
    except OSError:
        return url
    return f"{url.rstrip('/')}/?v={version}"


def _interrupt(*_: object) -> None:
    raise KeyboardInterrupt


def launch() -> tuple[str, ServerThread | None, str | None, Path | None]:
    """Réglages puis serveur : (adresse, serveur démarré par nous, erreur, dossier de l'interface compilée)."""
    try:
        settings = get_settings()
        url, server, error = prepare(settings)
    except ImportError as exc:
        log.exception("Modules Python manquants")
        launcher.forget_stamp()  # environnement Python incomplet : pip sera refait au prochain lancement
        missing = f" ({exc.name})" if exc.name else ""
        message = f"Des modules Python manquent{missing}. Relancez l'application : la mise à jour sera retentée."
        return "", None, message, None
    return url, server, error, settings.frontend_dist


def window_icon(platform: str | None = None) -> str | None:
    """Icône de la fenêtre : `.ico` sous Windows (WinForms n'accepte que ce format), PNG ailleurs."""
    icon = WINDOWS_ICON if (platform or sys.platform) == "win32" else ICON
    return str(icon) if icon.is_file() else None


WEBVIEW2_CLIENT = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
"""Identifiant du runtime Microsoft Edge WebView2 dans les clés EdgeUpdate."""


def webview2_available(read: Callable[[str, str], str | None] | None = None) -> bool:
    """Windows : vrai si le runtime WebView2 est installé (version ≥ 86, comme pywebview).

    Sans lui, pywebview se rabat sur l'ancien moteur d'Internet Explorer, incapable d'afficher l'interface :
    l'application s'ouvre alors dans le navigateur par défaut. `read(ruche, clé)` → valeur `pv`, injectable.
    """
    read = read or _registry_pv
    for hive, key in (
        ("HKEY_CURRENT_USER", rf"SOFTWARE\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_CLIENT}"),
        ("HKEY_LOCAL_MACHINE", rf"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_CLIENT}"),
        ("HKEY_LOCAL_MACHINE", rf"SOFTWARE\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_CLIENT}"),
    ):
        version = read(hive, key) or ""
        major = version.split(".")[0]
        if major.isdigit() and int(major) >= 86:
            return True
    return False


def _registry_pv(hive: str, key: str) -> str | None:
    if sys.platform != "win32":
        return None
    import winreg

    try:
        with winreg.OpenKey(getattr(winreg, hive), key) as handle:
            value, _ = winreg.QueryValueEx(handle, "pv")
    except OSError:
        return None
    return str(value)


def _window_options() -> dict[str, Any]:
    return {
        "width": WINDOW_SIZE[0],
        "height": WINDOW_SIZE[1],
        "min_size": MIN_SIZE,
        "text_select": True,
        "zoomable": True,
    }


def run(
    argv: list[str] | None = None,
    *,
    auto_update: bool = False,
    updater_factory: Callable[[], launcher.Updater] = launcher.Updater,
) -> int:
    """Point d'entrée de l'application de bureau.

    `auto_update` (vrai pour `backend/desktop.py`, donc pour « Atelier Viz.app ») : mise à jour depuis le dépôt
    avant l'ouverture (docs/SUITE.md §8), avec un écran « Mise à jour… » ; jamais dans le paquet autonome.
    """
    parser = argparse.ArgumentParser(description=f"{APP_NAME} — application de bureau")
    parser.add_argument("--browser", action="store_true", help="ouvrir dans le navigateur au lieu d'une fenêtre")
    parser.add_argument(
        "--sans-mise-a-jour", dest="no_update", action="store_true", help="ne pas vérifier la mise à jour au lancement"
    )
    parser.add_argument(
        "--mise-a-jour-seule",
        dest="update_only",
        action="store_true",
        help="faire la mise à jour depuis le dépôt puis s'arrêter (code de sortie), sans fenêtre",
    )
    ensure_log_streams()
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s : %(message)s")
    if auto_update:
        # docs/SUITE.md §9.4 : variables héritées d'une autre app (DATA_DIR, NODE_ENV…) ignorées ; réglages de
        # Viz dans backend/.env.
        ignored = launcher.scrub_inherited_env()
        if ignored:
            log.info("Variables héritées ignorées : %s", ", ".join(ignored))
    if args.update_only:
        return update_only(updater_factory) if auto_update else 0

    updater: launcher.Updater | None = None
    steps: tuple[launcher.Step, ...] = ()
    offline = True
    if update_wanted(auto_update, args.no_update):
        try:
            candidate = updater_factory()
            steps = candidate.plan().steps
        except Exception:  # noqa: BLE001 — un dépôt illisible ne doit pas empêcher l'ouverture
            log.exception("État du dépôt illisible : mise à jour ignorée.")
        else:
            if steps:
                log.info("Mise à jour nécessaire : %s", ", ".join(steps))
                updater = candidate
                offline = not launcher.online_mode(launcher.local_data_dir(Path.cwd()))

    if not args.browser and sys.platform == "win32" and not webview2_available():
        log.warning("WebView2 absent : navigateur utilisé (winget install Microsoft.EdgeWebView2Runtime).")
        args.browser = True

    first: launcher.UpdateResult | None = None
    if updater is not None and not args.browser and pip_before_window(steps):
        first = python_first(updater)  # avant d'importer pywebview (fichiers chargés non remplaçables)

    webview: Any = None
    if not args.browser:
        _name_macos_app()
        try:
            import webview  # type: ignore[import-not-found,no-redef]
        except ImportError:
            log.warning("pywebview absent : navigateur utilisé (pip install -r requirements-desktop.txt).")

    if updater is not None and first is not None:
        updater = PresetResult(updater, first)  # type: ignore[assignment]  # l'échec s'affiche comme les autres
    if webview is None:
        if updater is not None and not _console_update(updater, offline):
            return 1
        return _run_browser()
    return _run_window(webview, updater, offline)


def _run_browser() -> int:
    url, server, error, _ = launch()
    try:
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
    finally:
        if server is not None:
            log.info("Arrêt du serveur.")
            server.stop()


# macOS : « Quitter » (⌘Q, menu, Dock, fermeture de session) fait appeler `exit()` par AppKit pendant que
# Python tourne encore ; les destructeurs C++ de DuckDB s'exécutent alors sans le verrou Python
# (« Fatal Python error: PyEval_SaveThread ») et macOS affiche « Atelier Viz a quitté inopinément ».
# On arrête donc tout proprement dès la demande de fermeture, puis on sort sans repasser par `exit()`.
EXIT_ON_CLOSING = sys.platform == "darwin"
_hard_exit: Callable[[int], None] = os._exit


def stop_servers(servers: list[ServerThread]) -> None:
    """Arrête les serveurs (la base DuckDB est fermée par le cycle de vie de l'application)."""
    for server in list(servers):
        log.info("Arrêt du serveur.")
        server.stop()


def quit_handler(
    servers: list[ServerThread], outcome: dict[str, int], session: UpdateSession | None = None
) -> Callable[[], None]:
    """Demande de fermeture (fenêtre ou « Quitter ») : arrêt propre, journal vidé, sortie immédiate du processus."""

    def on_closing() -> None:
        if session is not None:
            session.close()  # une attente de choix se termine par « quit »
        stop_servers(servers)
        log.info("Fermeture d'%s.", APP_NAME)
        for handler in logging.getLogger().handlers:
            with contextlib.suppress(Exception):
                handler.flush()
        for stream in (sys.stdout, sys.stderr):
            with contextlib.suppress(Exception):
                if stream is not None:
                    stream.flush()
        _hard_exit(outcome["code"])

    return on_closing


def _run_window(webview: Any, updater: launcher.Updater | None, offline: bool) -> int:
    """Fenêtre native ; avec une mise à jour, elle affiche d'abord l'écran « Mise à jour… » puis l'interface."""
    api = DesktopApi()
    api.save_dialog = webview.FileDialog.SAVE
    webview.settings["ALLOW_DOWNLOADS"] = True
    webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True
    icon = window_icon()
    servers: list[ServerThread] = []
    outcome = {"code": 0}
    try:
        if updater is None:
            url, server, error, dist = launch()
            if server is not None:
                servers.append(server)
            window = webview.create_window(
                APP_NAME,
                url=None if error or dist is None else versioned_url(url, dist),
                html=error_page(error) if error else None,
                js_api=api,
                **_window_options(),
            )
            api.window = window
            outcome["code"] = 1 if error else 0
            boot: Callable[[], None] | None = None
        else:
            session = UpdateSession(str(updater.log))
            api._update = session
            window = webview.create_window(APP_NAME, html=splash_page(), js_api=api, **_window_options())
            api.window = window
            closed = threading.Event()

            def on_closed() -> None:
                closed.set()
                session.close()

            window.events.closed += on_closed

            def boot() -> None:
                if not run_update(updater, session, offline=offline):
                    outcome["code"] = 1
                    if not closed.is_set():
                        window.destroy()
                    return
                if closed.is_set():
                    return
                url, server, error, dist = launch()
                if server is not None:
                    servers.append(server)
                if error or dist is None:
                    outcome["code"] = 1
                    window.load_html(error_page(error or "Interface introuvable."))
                else:
                    window.load_url(versioned_url(url, dist))

        if EXIT_ON_CLOSING:
            window.events.closing += quit_handler(servers, outcome, api._update)
        storage = launcher.local_data_dir(Path.cwd()).resolve() / "webview"
        storage.mkdir(parents=True, exist_ok=True)
        # Stockage persistant : thème, options d'export… conservés d'un lancement à l'autre.
        if boot is None:
            webview.start(private_mode=False, storage_path=str(storage), icon=icon)
        else:
            webview.start(boot, private_mode=False, storage_path=str(storage), icon=icon)
        return outcome["code"]
    finally:
        stop_servers(servers)
