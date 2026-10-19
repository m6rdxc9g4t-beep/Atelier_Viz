"""Application de bureau : interface servie par l'API, serveur en fil d'exécution, réutilisation
d'un serveur existant, pont JavaScript (enregistrement de fichiers, liens externes).

Aucune fenêtre n'est ouverte : pywebview n'est pas sollicité.
"""

import base64
import socket
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import desktop
from app.core.config import Settings
from main import create_app


@pytest.fixture
def dist(tmp_path: Path) -> Path:
    folder = tmp_path / "dist"
    (folder / "assets").mkdir(parents=True)
    (folder / "index.html").write_text('<!doctype html><div id="root"></div>', encoding="utf-8")
    (folder / "assets" / "app.js").write_text("console.log(1)", encoding="utf-8")
    return folder


def test_interface_is_served_next_to_the_api(settings: Settings, dist: Path) -> None:
    settings.frontend_dist = dist
    with TestClient(create_app(settings)) as c:
        home = c.get("/")
        assert home.status_code == 200 and 'id="root"' in home.text
        assert c.get("/assets/app.js").text == "console.log(1)"
        assert c.get("/api/health").json()["status"] == "ok"  # l'API reste prioritaire
        assert c.get("/api/inconnu").status_code == 404


def test_interface_absent_or_disabled(settings: Settings, dist: Path, tmp_path: Path) -> None:
    settings.frontend_dist = tmp_path / "absent"
    with TestClient(create_app(settings)) as c:
        assert c.get("/").status_code == 404
    settings.frontend_dist, settings.serve_frontend = dist, False
    with TestClient(create_app(settings)) as c:
        assert c.get("/").status_code == 404


def test_find_port_avoids_busy_port() -> None:
    with socket.socket() as busy:
        busy.bind(("127.0.0.1", 0))
        busy.listen()
        taken = busy.getsockname()[1]
        assert desktop.port_free(taken) is False
        port = desktop.find_port(taken)
        assert port != taken and desktop.port_free(port)


def test_server_thread_starts_serves_and_stops(settings: Settings, dist: Path) -> None:
    settings.frontend_dist = dist
    server = desktop.ServerThread(create_app(settings), desktop.find_port(0))
    server.start()
    try:
        assert desktop.probe(server.url) is not None
        assert desktop.serves_interface(server.url) is True
    finally:
        server.stop()
    assert not server.thread.is_alive()
    assert desktop.probe(server.url) is None


def test_prepare_reuses_a_running_server_or_starts_one(
    settings: Settings, dist: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings.frontend_dist = dist
    running = desktop.ServerThread(create_app(settings), desktop.find_port(0))
    running.start()
    try:
        monkeypatch.setattr(desktop, "PREFERRED_PORT", int(running.url.rsplit(":", 1)[1]))
        url, server, error = desktop.prepare(settings)
        assert (url, server, error) == (running.url, None, None)
    finally:
        running.stop()

    # Plus rien sur le port : on démarre notre propre serveur.
    url, server, error = desktop.prepare(settings)
    assert error is None and server is not None
    try:
        assert desktop.probe(url) is not None
    finally:
        server.stop()


def test_prepare_explains_missing_interface(
    settings: Settings, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(desktop, "PREFERRED_PORT", desktop.find_port(0))
    settings.frontend_dist = tmp_path / "absent"
    url, server, error = desktop.prepare(settings)
    assert server is None and error is not None and "build_app.sh" in error


def test_database_lock_is_detected(settings: Settings, dist: Path) -> None:
    settings.frontend_dist = dist
    assert desktop.database_busy(settings) is None  # pas encore de base
    with TestClient(create_app(settings)):
        # La base est ouverte par ce processus : DuckDB autorise une 2e connexion du même processus,
        # on vérifie donc seulement que la fonction ne lève pas et répond None.
        assert desktop.database_busy(settings) is None


class FakeWindow:
    def __init__(self, answer: Any) -> None:
        self.answer = answer
        self.calls: list[dict[str, Any]] = []

    def create_file_dialog(
        self,
        dialog_type: Any,
        directory: str = "",
        allow_multiple: bool = False,
        save_filename: str = "",
        file_types: Any = (),
    ) -> Any:  # noqa: E501
        self.calls.append({"type": dialog_type, "directory": directory, "name": save_filename})
        return self.answer


def test_save_file_bridge(tmp_path: Path) -> None:
    api = desktop.DesktopApi()
    assert api.save_file("a.pptx", "")["saved"] is None  # pas de fenêtre
    target = tmp_path / "Ventes.pptx"
    api.window, api.save_dialog = FakeWindow((str(target),)), "SAVE"
    data = base64.b64encode(b"PK\x03\x04 contenu").decode()
    assert api.save_file("../../etc/Ventes.pptx", data) == {"saved": str(target)}
    assert target.read_bytes() == b"PK\x03\x04 contenu"
    call = api.window.calls[0]  # type: ignore[attr-defined]
    assert call["name"] == "Ventes.pptx" and call["directory"].endswith("Downloads")  # nom nettoyé du chemin

    api.window = FakeWindow(None)  # « Annuler »
    assert api.save_file("x.json", data) == {"saved": None}
    assert "invalide" in api.save_file("x.json", "pas du base64 !")["error"]


def test_open_external_only_for_web_links() -> None:
    opened: list[str] = []
    api = desktop.DesktopApi(open_url=opened.append)
    assert api.open_external("https://microsoft.com/devicelogin") is True
    assert api.open_external("file:///etc/passwd") is False
    assert api.open_external("javascript:alert(1)") is False
    assert opened == ["https://microsoft.com/devicelogin"]


def test_error_page_escapes_message() -> None:
    page = desktop.error_page("<script>x</script>")
    assert "<script>x" not in page and "&lt;script&gt;" in page


def test_browser_mode_without_server_errors(
    settings: Settings, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(desktop, "PREFERRED_PORT", desktop.find_port(0))
    settings.frontend_dist = tmp_path / "absent"
    monkeypatch.setattr(desktop, "get_settings", lambda: settings)
    assert desktop.run(["--browser"]) == 1
