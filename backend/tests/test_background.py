"""Actualisation quand l'application est fermée : passage sans serveur (`app/background.py`) et installation
de la tâche du système (launchd, schtasks, systemd) avec un exécuteur simulé — aucune vraie commande.
"""

import asyncio
import plistlib
import shutil
import sqlite3
import subprocess
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.background import BackgroundStatus, read_status, refresh_due
from app.core.config import Settings
from app.services.background_job import (
    LABEL,
    WINDOWS_TASK,
    BackgroundJob,
    BackgroundJobError,
    BackgroundJobInput,
    Environment,
)
from main import create_app
from tests.test_refresh import base, import_sqlite  # noqa: F401 — fixture réutilisée


def test_refresh_due_runs_schedules_and_alerts_without_the_app(settings: Settings, base: Path) -> None:  # noqa: F811
    with TestClient(create_app(settings)) as client:
        ds = import_sqlite(client, base)
        assert (
            client.put(f"/api/refresh/{ds['id']}", json={"mode": "interval", "every": 1, "unit": "hours"}).status_code
            == 200
        )
        alert = {
            "name": "Gros CA",
            "dataset_id": ds["id"],
            "measure": {"field": "ca", "agg": "sum"},
            "comparison": "gt",
            "threshold": 100,
            "system": False,
        }
        assert client.post("/api/alerts", json=alert).status_code == 201
    con = sqlite3.connect(base)
    con.execute("INSERT INTO ventes VALUES ('Est', 500.0)")
    con.commit()
    con.close()

    # Application fermée : la base n'est plus verrouillée, le passage actualise l'échéance (rattrapage).
    status = asyncio.run(refresh_due(settings, now=datetime.now(UTC) + timedelta(hours=2)))
    assert status.status == "done" and status.refreshed == 1 and status.failed == 0
    assert read_status(settings).refreshed == 1

    with TestClient(create_app(settings)) as client:
        assert client.get(f"/api/datasets/{ds['id']}").json()["rows"] == 3
        alerts = client.get("/api/alerts").json()
        assert alerts[0]["history"][0]["fired"] is True  # alerte évaluée après l'actualisation
        runs = client.get(f"/api/refresh/{ds['id']}").json()["runs"]
        assert runs[0]["trigger"] == "schedule" and runs[0]["status"] == "success"
        # Rien d'autre à échéance au passage suivant.
        state = client.get("/api/background").json()
        assert state["last"]["status"] == "done"


def test_refresh_due_stops_when_the_app_is_open(settings: Settings) -> None:
    with TestClient(create_app(settings)):
        # DuckDB verrouillé par l'application : un second processus ne peut pas l'ouvrir.
        import duckdb

        real = duckdb.connect

        def locked(*args, **kwargs):  # type: ignore[no-untyped-def]
            raise duckdb.IOException("Could not set lock on file")

        duckdb.connect = locked  # type: ignore[assignment]
        try:
            status = asyncio.run(refresh_due(settings))
        finally:
            duckdb.connect = real  # type: ignore[assignment]
    assert status.status == "app_open"
    assert not (settings.data_dir / "background.lock").exists()


def test_refresh_due_reports_unreadable_database_as_error(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    import duckdb

    def broken(*args, **kwargs):  # type: ignore[no-untyped-def]
        raise duckdb.IOException("Permission denied")

    monkeypatch.setattr(duckdb, "connect", broken)
    status = asyncio.run(refresh_due(settings))
    assert status.status == "error" and "Permission denied" in (status.message or "")


def test_refresh_due_leaves_a_marker_only_while_running(settings: Settings, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services.refresh import RefreshScheduler

    seen: list[bool] = []
    real = RefreshScheduler.tick

    async def tick(self, *a, **k):  # type: ignore[no-untyped-def]
        seen.append((settings.data_dir / "background.lock").exists())
        return await real(self, *a, **k)

    monkeypatch.setattr(RefreshScheduler, "tick", tick)
    assert asyncio.run(refresh_due(settings)).status == "done"
    assert seen == [True] and not (settings.data_dir / "background.lock").exists()


class Recorder:
    """Exécuteur simulé : retient les commandes, répond `returncode`."""

    def __init__(self, returncode: int = 0, stdout: str = "") -> None:
        self.calls: list[list[str]] = []
        self.returncode = returncode
        self.stdout = stdout

    def __call__(self, args: Sequence[str]) -> subprocess.CompletedProcess[str]:
        self.calls.append(list(args))
        return subprocess.CompletedProcess(list(args), self.returncode, self.stdout, "erreur simulée")


def job(tmp_path: Path, platform: str, runner: Recorder, frozen: bool = False) -> BackgroundJob:
    entry = tmp_path / "Atelier Viz é" / "backend" / "refresh_once.py"
    entry.parent.mkdir(parents=True)
    entry.write_text("", encoding="utf-8")
    env = Environment(
        platform=platform,
        home=tmp_path / "home",
        python=tmp_path / "venv" / "python",
        entry=entry,
        frozen=frozen,
        runner=runner,
    )
    return BackgroundJob(env, BackgroundStatus)


def test_launchd_install_update_and_remove(tmp_path: Path) -> None:
    run = Recorder()
    j = job(tmp_path, "darwin", run)
    assert j.state().supported and not j.state().installed
    state = j.apply(BackgroundJobInput(enabled=True, interval_minutes=30))
    assert state.installed and state.interval_minutes == 30
    plist = plistlib.loads((tmp_path / "home" / "Library" / "LaunchAgents" / f"{LABEL}.plist").read_bytes())
    assert plist["ProgramArguments"][1].endswith("refresh_once.py") and plist["StartInterval"] == 1800
    assert run.calls[-1][:2] == ["launchctl", "bootstrap"]
    j.apply(BackgroundJobInput(enabled=True, interval_minutes=15))
    assert ["launchctl", "bootout"] == run.calls[-2][:2] and j.state().interval_minutes == 15
    assert not j.apply(BackgroundJobInput(enabled=False)).installed


def test_launchd_retries_bootstrap_and_never_leaves_a_dead_agent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.services.background_job._sleep", lambda s: None)

    class Flaky(Recorder):
        def __init__(self, failures: int) -> None:
            super().__init__()
            self.failures = failures

        def __call__(self, args: Sequence[str]) -> subprocess.CompletedProcess[str]:
            self.calls.append(list(args))
            if args[1] == "bootstrap" and self.failures > 0:
                self.failures -= 1
                return subprocess.CompletedProcess(list(args), 5, "", "Bootstrap failed: 5: Input/output error")
            return subprocess.CompletedProcess(list(args), 0, "", "")

    run = Flaky(2)
    assert job(tmp_path, "darwin", run).apply(BackgroundJobInput(enabled=True, interval_minutes=30)).installed
    assert sum(1 for c in run.calls if c[1] == "bootstrap") == 3

    always = Flaky(99)
    j = job(tmp_path / "b", "darwin", always)
    with pytest.raises(BackgroundJobError):
        j.apply(BackgroundJobInput(enabled=True, interval_minutes=30))
    assert not j.state().installed  # pas d'agent sur le disque qui ne tourne pas


def test_systemd_units_quote_paths(tmp_path: Path) -> None:
    run = Recorder()
    j = job(tmp_path, "linux", run)
    state = j.apply(BackgroundJobInput(enabled=True, interval_minutes=60))
    assert state.installed and state.interval_minutes == 60
    service = (tmp_path / "home" / ".config" / "systemd" / "user" / "atelier-viz-refresh.service").read_text()
    assert 'ExecStart="' in service and "Atelier Viz é" in service
    assert "WorkingDirectory" not in service  # systemd ne retire pas les guillemets de WorkingDirectory=
    assert ["systemctl", "--user", "enable", "--now", "atelier-viz-refresh.timer"] in run.calls
    if shutil.which("systemd-analyze"):
        units = tmp_path / "home" / ".config" / "systemd" / "user"
        (tmp_path / "venv").mkdir(exist_ok=True)
        (tmp_path / "venv" / "python").write_text("#!/bin/sh\n", encoding="utf-8")
        (tmp_path / "venv" / "python").chmod(0o755)
        res = subprocess.run(
            ["systemd-analyze", "verify", str(units / "atelier-viz-refresh.service")],
            capture_output=True,
            text=True,
            check=False,
        )
        out = (res.stdout + res.stderr).lower()
        assert "fatal" not in out and "bad unit" not in out, res.stderr
    assert not j.apply(BackgroundJobInput(enabled=False)).installed


def test_windows_task_without_shell(tmp_path: Path) -> None:
    run = Recorder(stdout="<Interval>PT20M</Interval>")
    j = job(tmp_path, "win32", run)
    j.apply(BackgroundJobInput(enabled=True, interval_minutes=20))
    create = next(c for c in run.calls if "/Create" in c)
    assert create[0] == "schtasks" and WINDOWS_TASK in create and create[create.index("/MO") + 1] == "20"
    assert create[-1].startswith('"') and "refresh_once.py" in create[-1]
    assert j.state().interval_minutes == 20
    j.apply(BackgroundJobInput(enabled=False))
    assert ["schtasks", "/Delete", "/TN", WINDOWS_TASK, "/F"] in run.calls


def test_errors_and_unsupported(tmp_path: Path) -> None:
    with pytest.raises(BackgroundJobError, match="launchctl"):
        job(tmp_path / "a", "darwin", Recorder(returncode=1)).apply(BackgroundJobInput(enabled=True))
    frozen = job(tmp_path / "b", "darwin", Recorder(), frozen=True)
    assert not frozen.state().supported and "autonome" in (frozen.state().reason or "")
    with pytest.raises(BackgroundJobError):
        frozen.apply(BackgroundJobInput(enabled=True))
    with pytest.raises(ValueError):
        BackgroundJobInput(enabled=True, interval_minutes=1)


def test_background_api(client: TestClient) -> None:
    state = client.get("/api/background").json()
    assert set(state) >= {"supported", "installed", "platform", "last"} and state["last"]["status"] == "never"
    assert client.put("/api/background", json={"enabled": True, "interval_minutes": 2}).status_code == 422
