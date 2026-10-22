"""Écran « Mise à jour… » de l'application de bureau (docs/SUITE.md §8) : pywebview simulé, mise à jour simulée."""

from __future__ import annotations

import re
import sys
from collections.abc import Callable
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from app import desktop, launcher, standalone
from app.launcher import UpdateResult


class FakeUpdater:
    """Remplace `launcher.Updater` : étapes et résultat imposés."""

    def __init__(self, result: UpdateResult | Exception, steps: tuple[launcher.Step, ...] = ("npm", "build")) -> None:
        self.result = result
        self.steps = steps
        self.log = Path("/journal/mise-a-jour.log")
        self.ran = 0

    def plan(self) -> SimpleNamespace:
        return SimpleNamespace(steps=self.steps)

    def previous_available(self) -> bool:
        return True

    def run(self, on_status: launcher.StatusCallback) -> UpdateResult:
        self.ran += 1
        for i, step in enumerate(self.steps, start=1):
            on_status(launcher.LABELS[step], i, len(self.steps))
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


def failed(step: launcher.Step, previous: bool = True) -> UpdateResult:
    return UpdateResult(
        ok=False, failed_step=step, message=f"échec {step}", previous_available=previous, log="/journal/maj.log"
    )


def never(_: desktop.UpdateSession) -> desktop.UpdateChoice:
    raise AssertionError("aucun choix ne devait être demandé")


def test_session_choices() -> None:
    session = desktop.UpdateSession("/j.log")
    assert session.snapshot()["state"] == "running"
    assert session.choose("previous") is False  # pas d'échec : aucun choix
    session.status("Compilation…", 2, 3)
    assert session.snapshot()["index"] == 2 and session.snapshot()["label"] == "Compilation…"
    session.fail("échec", "/j.log", can_open_previous=False)
    assert session.choose("previous") is False  # aucune version précédente
    assert session.choose("n'importe quoi") is False
    assert session.choose("quit") is True and session.wait_choice(0) == "quit"
    other = desktop.UpdateSession()
    other.fail("échec", "/j.log", can_open_previous=True)
    assert other.choose("previous") and other.wait_choice(0) == "previous"
    closed = desktop.UpdateSession()
    closed.close()
    assert closed.wait_choice(0) == "quit"


def test_run_update_success_and_failures() -> None:
    ok = UpdateResult(ok=True, steps=("build",))
    session = desktop.UpdateSession()
    assert desktop.run_update(FakeUpdater(ok), session, offline=False, ask=never)  # type: ignore[arg-type]
    assert session.snapshot()["state"] == "done"

    # Échec : message, journal et choix « Ouvrir quand même avec la version précédente ».
    session = desktop.UpdateSession()
    asked: list[dict[str, Any]] = []

    def previous(s: desktop.UpdateSession) -> desktop.UpdateChoice:
        asked.append(s.snapshot())
        return "previous"

    assert desktop.run_update(FakeUpdater(failed("build")), session, offline=False, ask=previous)  # type: ignore[arg-type]
    assert asked[0]["state"] == "failed" and asked[0]["message"] == "échec build"
    assert asked[0]["log"] == "/journal/maj.log" and asked[0]["can_open_previous"] is True
    assert not desktop.run_update(
        FakeUpdater(failed("npm")),  # type: ignore[arg-type]
        desktop.UpdateSession(),
        offline=False,
        ask=lambda s: "quit",
    )
    # Exception inattendue : traitée comme un échec, l'utilisateur choisit.
    session = desktop.UpdateSession()
    assert desktop.run_update(FakeUpdater(RuntimeError("boum")), session, offline=False, ask=previous)  # type: ignore[arg-type]
    assert "boum" in asked[-1]["message"]


def test_offline_install_failure_opens_previous_version() -> None:
    """Hors ligne : registres injoignables → version précédente sans question ; nouvel essai au lancement suivant."""
    for step in ("pip", "npm"):
        session = desktop.UpdateSession()
        assert desktop.run_update(FakeUpdater(failed(step)), session, offline=True, ask=never)  # type: ignore[arg-type]
        assert session.snapshot()["state"] == "done"
    # Une compilation en échec n'est pas une erreur réseau ; sans version précédente, on demande aussi.
    asked: list[str] = []

    def quit_(s: desktop.UpdateSession) -> desktop.UpdateChoice:
        asked.append(s.snapshot()["message"])
        return "quit"

    for result in (failed("build"), failed("npm", previous=False)):
        assert not desktop.run_update(FakeUpdater(result), desktop.UpdateSession(), offline=True, ask=quit_)  # type: ignore[arg-type]
    assert asked == ["échec build", "échec npm"]


def test_splash_page_is_self_contained() -> None:
    page = desktop.splash_page()
    assert "Mise à jour d'Atelier Viz…" in page and "update_state" in page and "update_choice" in page
    assert "Ouvrir quand même avec la version précédente" in page
    assert not re.search(r"(src|href)=|https?://|@import|url\(", page)  # aucune ressource externe


def test_desktop_api_exposes_the_update_state() -> None:
    api = desktop.DesktopApi()
    assert api.update_state() == {"state": "done"} and api.update_choice("quit") is False
    api._update = desktop.UpdateSession()
    api._update.fail("échec", "/j.log", can_open_previous=True)
    assert api.update_state()["state"] == "failed"
    assert api.update_choice("previous") is True


def test_update_never_runs_in_the_standalone_package(monkeypatch: pytest.MonkeyPatch) -> None:
    assert desktop.update_wanted(True, False, frozen=False) is True
    assert desktop.update_wanted(True, False, frozen=True) is False
    assert desktop.update_wanted(True, True, frozen=False) is False  # --sans-mise-a-jour
    assert desktop.update_wanted(False, False, frozen=False) is False

    def forbidden() -> launcher.Updater:
        raise AssertionError("aucune mise à jour (ni npm) dans le paquet autonome")

    monkeypatch.setattr(desktop, "_run_browser", lambda: 0)
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    assert desktop.run(["--browser"], auto_update=True, updater_factory=forbidden) == 0
    monkeypatch.delattr(sys, "frozen")
    assert desktop.run(["--browser", "--sans-mise-a-jour"], auto_update=True, updater_factory=forbidden) == 0
    assert desktop.run(["--browser"], updater_factory=forbidden) == 0  # tests, standalone : désactivée par défaut

    # Le paquet autonome appelle run() sans mise à jour.
    calls: list[tuple[list[str], dict[str, Any]]] = []
    monkeypatch.setattr(desktop, "run", lambda args, **kw: calls.append((args, kw)) or 0)
    monkeypatch.setenv("ATELIER_HOME", str(Path.cwd() / "_inutilise"))
    monkeypatch.setattr(standalone, "configure", lambda: Path("."))
    monkeypatch.setattr(standalone.os, "chdir", lambda _: None)
    assert standalone.main(["--browser"]) == 0
    assert calls and calls[0][1].get("auto_update", False) is False


def test_browser_mode_updates_in_the_console(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(desktop, "_run_browser", lambda: 0)
    updater = FakeUpdater(UpdateResult(ok=True, steps=("npm", "build")))
    assert desktop.run(["--browser"], auto_update=True, updater_factory=lambda: updater) == 0  # type: ignore[arg-type,return-value]
    out = capsys.readouterr().out
    assert "1/2 · Installation des dépendances de l'interface (npm ci)…" in out and updater.ran == 1
    # Échec sans version précédente : l'application ne s'ouvre pas.
    broken = FakeUpdater(failed("build", previous=False))
    assert desktop.run(["--browser"], auto_update=True, updater_factory=lambda: broken) == 1  # type: ignore[arg-type,return-value]
    assert "Mise à jour en échec : échec build" in capsys.readouterr().err
    # Rien à faire : pas de mise à jour lancée.
    idle = FakeUpdater(UpdateResult(ok=True), steps=())
    assert desktop.run(["--browser"], auto_update=True, updater_factory=lambda: idle) == 0  # type: ignore[arg-type,return-value]
    assert idle.ran == 0


# --- Fenêtre (pywebview simulé) -------------------------------------------------------------------------


class Event:
    def __init__(self) -> None:
        self.handlers: list[Callable[[], None]] = []

    def __iadd__(self, handler: Callable[[], None]) -> Event:
        self.handlers.append(handler)
        return self


class FakeWindow:
    def __init__(self, **kwargs: Any) -> None:
        self.kwargs = kwargs
        self.events = SimpleNamespace(closed=Event())
        self.loaded: list[tuple[str, str]] = []
        self.destroyed = False

    def load_url(self, url: str) -> None:
        self.loaded.append(("url", url))

    def load_html(self, page: str) -> None:
        self.loaded.append(("html", page))

    def destroy(self) -> None:
        self.destroyed = True


def fake_webview(on_start: Callable[[FakeWindow], None] | None = None) -> SimpleNamespace:
    windows: list[FakeWindow] = []

    def create_window(title: str, **kwargs: Any) -> FakeWindow:
        windows.append(FakeWindow(title=title, **kwargs))
        return windows[-1]

    def start(func: Callable[[], None] | None = None, **kwargs: Any) -> None:
        if on_start is not None:
            on_start(windows[-1])
        if func is not None:
            func()

    return SimpleNamespace(
        FileDialog=SimpleNamespace(SAVE="save"), settings={}, create_window=create_window, start=start, windows=windows
    )


@pytest.fixture
def window_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.chdir(tmp_path)  # stockage de la fenêtre : ./data/webview
    monkeypatch.delenv("DATA_DIR", raising=False)
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text('<div id="root"></div>', encoding="utf-8")
    monkeypatch.setattr(desktop, "launch", lambda: ("http://127.0.0.1:9", None, None, dist))
    return dist


def test_window_shows_the_splash_then_the_interface(window_env: Path) -> None:
    webview = fake_webview()
    updater = FakeUpdater(UpdateResult(ok=True, steps=("npm", "build")))
    assert desktop._run_window(webview, updater, offline=False) == 0  # type: ignore[arg-type]
    window = webview.windows[0]
    assert "update_state" in window.kwargs["html"] and window.kwargs.get("url") is None
    assert window.kwargs["js_api"]._update.snapshot()["state"] == "done"
    assert window.loaded == [("url", desktop.versioned_url("http://127.0.0.1:9", window_env))]
    assert (window_env.parent / "data" / "webview").is_dir()


def test_window_failure_then_quit_or_previous(window_env: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # « Quitter » : la fenêtre se ferme, code 1.
    def choose(choice: str) -> Callable[[desktop.UpdateSession], desktop.UpdateChoice]:
        def ask(session: desktop.UpdateSession) -> desktop.UpdateChoice:
            assert session.snapshot()["state"] == "failed"
            assert session.choose(choice)
            return session.wait_choice(0)

        return ask

    real = desktop.run_update
    monkeypatch.setattr(desktop, "run_update", lambda u, s, offline: real(u, s, offline=offline, ask=choose("quit")))
    webview = fake_webview()
    assert desktop._run_window(webview, FakeUpdater(failed("build")), offline=False) == 1  # type: ignore[arg-type]
    assert webview.windows[0].destroyed and webview.windows[0].loaded == []
    # « Ouvrir quand même avec la version précédente » : l'interface s'ouvre.
    monkeypatch.setattr(
        desktop, "run_update", lambda u, s, offline: real(u, s, offline=offline, ask=choose("previous"))
    )
    webview = fake_webview()
    assert desktop._run_window(webview, FakeUpdater(failed("build")), offline=False) == 0  # type: ignore[arg-type]
    assert webview.windows[0].loaded[0][0] == "url"


def test_closing_the_window_during_the_choice_quits(window_env: Path) -> None:
    def close_soon(window: FakeWindow) -> None:
        session: desktop.UpdateSession = window.kwargs["js_api"]._update
        for handler in window.events.closed.handlers:
            handler()  # fermée avant même le choix
        assert session.wait_choice(0) == "quit"

    webview = fake_webview(close_soon)
    assert desktop._run_window(webview, FakeUpdater(failed("build")), offline=False) == 1  # type: ignore[arg-type]
    assert webview.windows[0].loaded == [] and not webview.windows[0].destroyed


def test_window_without_update_opens_the_interface_directly(window_env: Path) -> None:
    webview = fake_webview()
    assert desktop._run_window(webview, None, offline=True) == 0
    window = webview.windows[0]
    assert window.kwargs["url"].startswith("http://127.0.0.1:9/?v=") and window.kwargs["html"] is None


def test_missing_python_modules_are_reported(monkeypatch: pytest.MonkeyPatch) -> None:
    def broken() -> None:
        raise ModuleNotFoundError("No module named 'rich'", name="rich")

    monkeypatch.setattr(desktop, "get_settings", broken)
    url, server, error, dist = desktop.launch()
    assert server is None and dist is None and error is not None
    assert "(rich)" in error and "Relancez l'application" in error
