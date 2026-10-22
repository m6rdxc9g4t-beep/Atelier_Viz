"""Écran « Mise à jour… » de l'application de bureau (docs/SUITE.md §8) : pywebview simulé, mise à jour simulée."""

from __future__ import annotations

import os
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
        self.events = SimpleNamespace(closed=Event(), closing=Event())
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
    forgotten: list[bool] = []
    monkeypatch.setattr(launcher, "forget_stamp", lambda: forgotten.append(True))
    url, server, error, dist = desktop.launch()
    assert forgotten == [True]  # la mise à jour (pip) sera vraiment retentée
    assert server is None and dist is None and error is not None
    assert "(rich)" in error and "Relancez l'application" in error


# --- Windows et lanceur (docs/SUITE.md §9) ------------------------------------------------------------------


def test_update_only_mode_reports_with_an_exit_code(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """`desktop.py --mise-a-jour-seule` (lanceur, CI §9.5) : mise à jour sans fenêtre ni serveur, puis code."""
    monkeypatch.setattr(desktop, "_run_browser", lambda: pytest.fail("aucun serveur en mise à jour seule"))
    monkeypatch.setattr(desktop, "_run_window", lambda *a: pytest.fail("aucune fenêtre en mise à jour seule"))
    done = FakeUpdater(UpdateResult(ok=True, steps=("build",)), steps=("build",))
    assert desktop.run(["--mise-a-jour-seule"], auto_update=True, updater_factory=lambda: done) == 0  # type: ignore[arg-type,return-value]
    assert "Application à jour." in capsys.readouterr().out and done.ran == 1
    idle = FakeUpdater(UpdateResult(ok=True), steps=())
    assert desktop.run(["--mise-a-jour-seule"], auto_update=True, updater_factory=lambda: idle) == 0  # type: ignore[arg-type,return-value]
    assert "Rien à mettre à jour." in capsys.readouterr().out
    broken = FakeUpdater(failed("npm"))
    assert desktop.run(["--mise-a-jour-seule"], auto_update=True, updater_factory=lambda: broken) == 1  # type: ignore[arg-type,return-value]
    assert "Mise à jour en échec : échec npm" in capsys.readouterr().err
    assert desktop.update_only(lambda: broken, frozen=True) == 0  # type: ignore[arg-type,return-value]  # paquet autonome


def test_desktop_launch_ignores_variables_of_other_apps(monkeypatch: pytest.MonkeyPatch) -> None:
    """§9.4 : lancée par une autre app, Viz ignore DATA_DIR, NODE_ENV… hérités (sa config : backend/.env)."""
    monkeypatch.setattr(desktop, "_run_browser", lambda: 0)
    monkeypatch.setenv("DATA_DIR", "/autre-app/data")
    monkeypatch.setenv("NODE_ENV", "production")
    monkeypatch.setenv("OLLAMA_MODEL", "llama3.2")
    idle = FakeUpdater(UpdateResult(ok=True), steps=())
    assert desktop.run(["--browser"], auto_update=True, updater_factory=lambda: idle) == 0  # type: ignore[arg-type,return-value]
    assert "DATA_DIR" not in os.environ and "NODE_ENV" not in os.environ
    assert os.environ["OLLAMA_MODEL"] == "llama3.2"
    # Paquet autonome et tests : run() sans auto_update ne touche pas à l'environnement (DATA_DIR du paquet).
    monkeypatch.setenv("DATA_DIR", "/paquet/data")
    assert desktop.run(["--browser"]) == 0
    assert os.environ["DATA_DIR"] == "/paquet/data"


class StepUpdater(FakeUpdater):
    """Accepte `only` comme `launcher.Updater` et note les appels."""

    def __init__(self, results: list[UpdateResult], steps: tuple[launcher.Step, ...]) -> None:
        super().__init__(results[0], steps)
        self.results = results
        self.only: list[Any] = []

    def run(self, on_status: launcher.StatusCallback = lambda *a: None, only: Any = None) -> UpdateResult:  # type: ignore[override]
        self.only.append(only)
        return self.results[len(self.only) - 1]


def test_windows_runs_pip_before_the_window(monkeypatch: pytest.MonkeyPatch) -> None:
    """§9.3 : pywebview charge des fichiers que pip ne pourrait plus remplacer → pip d'abord, puis la fenêtre."""
    assert desktop.pip_before_window(("pip", "build"), "win32") is True
    assert desktop.pip_before_window(("npm", "build"), "win32") is False
    assert desktop.pip_before_window(("pip", "build"), "darwin") is False

    def inline(task: Callable[[launcher.StatusCallback], Any]) -> Any:
        return task(lambda *a: None)

    ok = StepUpdater([UpdateResult(ok=True, steps=("pip",))], ("pip", "build"))
    assert desktop.python_first(ok, progress=inline) is None and ok.only == [("pip",)]  # type: ignore[arg-type]
    ko = StepUpdater([failed("pip")], ("pip", "build"))
    result = desktop.python_first(ko, progress=inline)  # type: ignore[arg-type]
    assert result is not None and result.failed_step == "pip"

    # Dans run() : pip avant l'import de pywebview, puis l'échec s'affiche dans l'écran de démarrage.
    order: list[str] = []
    monkeypatch.setattr(desktop, "pip_before_window", lambda steps: True)
    monkeypatch.setattr(desktop, "python_first", lambda updater: order.append("pip") or failed("pip"))
    monkeypatch.setattr(desktop, "_name_macos_app", lambda: order.append("fenêtre"))
    seen: dict[str, Any] = {}

    def window(webview: Any, updater: Any, offline: bool) -> int:
        seen["result"] = updater.run()
        return 0

    monkeypatch.setattr(desktop, "_run_window", window)
    monkeypatch.setitem(sys.modules, "webview", SimpleNamespace())
    pending = FakeUpdater(UpdateResult(ok=True), steps=("pip", "build"))
    assert desktop.run([], auto_update=True, updater_factory=lambda: pending) == 0  # type: ignore[arg-type,return-value]
    assert order == ["pip", "fenêtre"] and seen["result"].failed_step == "pip" and pending.ran == 0


def test_tk_progress_without_display_still_runs_the_task(monkeypatch: pytest.MonkeyPatch) -> None:
    class NoDisplay:
        @staticmethod
        def Tk() -> None:  # noqa: N802 — comme tkinter
            raise RuntimeError("pas d'affichage")

    monkeypatch.setitem(sys.modules, "tkinter", NoDisplay)
    assert desktop.tk_progress(lambda status: status("x", 1, 1) or "fait") == "fait"


def test_without_console_output_goes_to_the_log(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """`pythonw.exe` (Windows) : pas de sortie standard ; tout va dans atelier-viz.log (gardé une fois > 5 Mo)."""
    log = tmp_path / "Logs" / "atelier-viz.log"
    assert desktop.ensure_log_streams(log) is None  # terminal : rien à faire
    monkeypatch.setattr(sys, "stdout", None)
    monkeypatch.setattr(sys, "stderr", None)
    monkeypatch.setattr(launcher, "ROTATE_LOG_BYTES", 10)
    log.parent.mkdir()
    log.write_text("ancien journal trop long\n", encoding="utf-8")
    assert desktop.ensure_log_streams(log) == log
    print("bonjour")
    sys.stderr.write("erreur\n")
    stream = sys.stdout
    monkeypatch.undo()
    stream.close()
    text = log.read_text(encoding="utf-8")
    assert "lancement" in text and "bonjour" in text and "erreur" in text
    assert "ancien" in (tmp_path / "Logs" / "atelier-viz.log.1").read_text(encoding="utf-8")


def test_log_file_and_error_page_hint_per_platform(tmp_path: Path) -> None:
    assert desktop.app_log_file("darwin", tmp_path) == tmp_path / "Library" / "Logs" / "Atelier Viz" / "atelier-viz.log"
    win = desktop.app_log_file("win32", tmp_path)
    assert win.parts[-3:] == ("Atelier Viz", "Logs", "atelier-viz.log")
    assert "atelier-viz.log" in desktop.error_page("x")


def test_webview2_detection_and_window_icon() -> None:
    """Sans WebView2 (≥ 86), pywebview afficherait l'interface avec l'ancien moteur d'IE : navigateur à la place."""
    found = {("HKEY_LOCAL_MACHINE", rf"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{desktop.WEBVIEW2_CLIENT}")}
    assert desktop.webview2_available(lambda hive, key: "131.0.2903.70" if (hive, key) in found else None)
    assert desktop.webview2_available(lambda hive, key: "0.0.0.0") is False
    assert desktop.webview2_available(lambda hive, key: None) is False
    assert desktop.webview2_available(lambda hive, key: "85.0.1") is False
    # WinForms n'accepte qu'une icône .ico (le PNG de macOS ferait échouer la fenêtre).
    assert (desktop.window_icon("win32") or "").endswith("atelier-viz.ico")
    assert (desktop.window_icon("darwin") or "").endswith("icon.png")


def test_windows_without_webview2_opens_in_the_browser(monkeypatch: pytest.MonkeyPatch) -> None:
    opened: list[str] = []
    monkeypatch.setattr(desktop.sys, "platform", "win32")
    monkeypatch.setattr(desktop, "webview2_available", lambda: False)
    monkeypatch.setattr(desktop, "_run_browser", lambda: opened.append("navigateur") or 0)
    monkeypatch.setattr(desktop, "_run_window", lambda *a: pytest.fail("pas de fenêtre sans WebView2"))
    monkeypatch.setitem(sys.modules, "webview", SimpleNamespace())
    assert desktop.run([]) == 0 and opened == ["navigateur"]


# --- « Quitter » sous macOS : arrêt propre puis sortie immédiate (jamais `exit()` d'AppKit) ------------------


class Exited(Exception):
    def __init__(self, code: int) -> None:
        self.code = code


class FakeServer:
    def __init__(self) -> None:
        self.stopped = 0

    def stop(self) -> None:
        self.stopped += 1


def raise_exit(code: int) -> None:
    raise Exited(code)


def test_quit_handler_stops_servers_then_exits(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(desktop, "_hard_exit", raise_exit)
    server = FakeServer()
    session = desktop.UpdateSession("journal")
    handler = desktop.quit_handler([server], {"code": 1}, session)  # type: ignore[list-item]
    with pytest.raises(Exited) as exited:
        handler()
    assert exited.value.code == 1 and server.stopped == 1
    assert session.wait_choice(0) == "quit"


def test_closing_the_window_exits_on_macos(window_env: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(desktop, "EXIT_ON_CLOSING", True)
    monkeypatch.setattr(desktop, "_hard_exit", raise_exit)
    server = FakeServer()
    dist = window_env
    monkeypatch.setattr(desktop, "launch", lambda: ("http://127.0.0.1:9", server, None, dist))

    def quit_now(window: FakeWindow) -> None:
        assert len(window.events.closing.handlers) == 1
        window.events.closing.handlers[0]()  # ⌘Q : `applicationShouldTerminate_` → événement « closing »

    with pytest.raises(Exited) as exited:
        desktop._run_window(fake_webview(quit_now), None, offline=True)
    assert exited.value.code == 0 and server.stopped >= 1


def test_no_hard_exit_outside_macos(window_env: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(desktop, "EXIT_ON_CLOSING", False)
    webview = fake_webview()
    assert desktop._run_window(webview, None, offline=True) == 0
    assert webview.windows[0].events.closing.handlers == []
