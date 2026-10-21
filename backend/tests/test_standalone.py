"""Application autonome (PyInstaller) : dossiers par système, variables du serveur, auto-test."""

from pathlib import Path

import pytest

from app import standalone


def test_user_dir_per_platform(tmp_path: Path) -> None:
    home = tmp_path
    assert standalone.user_dir("darwin", {}, home) == home / "Library" / "Application Support" / "Atelier Viz"
    assert standalone.user_dir("win32", {"LOCALAPPDATA": str(tmp_path / "L")}, home) == tmp_path / "L" / "Atelier Viz"
    assert standalone.user_dir("win32", {}, home) == home / "AppData" / "Local" / "Atelier Viz"
    assert standalone.user_dir("linux", {}, home) == home / ".local" / "share" / "atelier-viz"
    assert standalone.user_dir("linux", {"XDG_DATA_HOME": str(tmp_path / "x")}, home) == tmp_path / "x" / "atelier-viz"


def test_configure_sets_server_variables_without_overriding(tmp_path: Path) -> None:
    env: dict[str, str] = {"SAMPLES_DIR": "/mes/exemples"}
    folder = standalone.configure(env, platform="linux", home=tmp_path)
    assert folder == tmp_path / ".local" / "share" / "atelier-viz" and folder.is_dir()
    assert env["DATA_DIR"] == str(folder / "data")
    assert env["SAMPLES_DIR"] == "/mes/exemples"  # déjà fixé : gardé
    assert env["SERVE_FRONTEND"] == "true"
    # Hors paquet, les ressources sont celles du dépôt.
    assert env["FRONTEND_DIST"].endswith(str(Path("frontend") / "dist"))
    other = standalone.configure({"ATELIER_HOME": str(tmp_path / "ailleurs")}, platform="darwin", home=tmp_path)
    assert other == tmp_path / "ailleurs"
    assert not standalone.frozen() and standalone.bundle_dir() == Path(standalone.__file__).resolve().parents[2]


def test_self_test_runs_the_real_server(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys) -> None:
    dist = tmp_path / "dist"
    dist.mkdir()
    (dist / "index.html").write_text('<div id="root"></div>', encoding="utf-8")
    monkeypatch.setenv("DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("FRONTEND_DIST", str(dist))
    monkeypatch.setenv("SCHEDULER_ENABLED", "false")
    monkeypatch.setenv("SYSTEM_NOTIFICATIONS", "false")
    from app.core.config import get_settings

    get_settings.cache_clear()
    try:
        assert standalone.self_test() == 0
    finally:
        get_settings.cache_clear()
    assert "API, interface et 3 exemple(s) OK" in capsys.readouterr().out
