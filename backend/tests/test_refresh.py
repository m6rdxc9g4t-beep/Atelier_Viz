"""Actualisation planifiée : calcul des échéances, ordonnanceur (horloge injectée, aucune attente réelle),
une exécution à la fois par jeu, journal, politique réseau, API.
"""

import asyncio
import json
import sqlite3
import threading
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.schemas.connection import DatasetOrigin
from app.schemas.dataset import ModelIssue
from app.schemas.refresh import RefreshSchedule
from app.services.connectors.base import ConnectorError
from app.services.data.model import ModelError
from app.services.data.store import DatasetStore, StoredDataset
from app.services.refresh import MAX_RUNS, RefreshScheduler, next_run

PARIS_ETE = timezone(timedelta(hours=2))


class Clock:
    """Horloge réglable à la main."""

    def __init__(self, now: datetime) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now

    def advance(self, **delta: float) -> None:
        self.now += timedelta(**delta)


@pytest.fixture
def base(tmp_path: Path) -> Path:
    path = tmp_path / "source.db"
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE ventes (region TEXT, ca REAL)")
    con.executemany("INSERT INTO ventes VALUES (?, ?)", [("Nord", 10.0), ("Sud", 5.0)])
    con.commit()
    con.close()
    return path


def import_sqlite(client: TestClient, path: Path) -> dict:
    conn = client.post("/api/connections", json={"name": "Base", "kind": "sqlite", "path": str(path)}).json()
    r = client.post(f"/api/connections/{conn['id']}/import", json={"table": {"name": "ventes"}})
    assert r.status_code == 201, r.text
    return r.json()


def add_origin_dataset(store: DatasetStore, kind: str = "sqlite") -> StoredDataset:
    origin = DatasetOrigin(
        connection_id="c" * 12, connection_name="Source", kind=kind, refreshed_at=datetime(2026, 1, 1, tzinfo=UTC)
    )
    return store.add("jeu", "sqlite", pd.DataFrame({"x": [1, 2]}), origin)


def make(client: TestClient, tmp_path: Path, refresher, clock: Clock, online: bool = False) -> RefreshScheduler:
    store = client.app.state.dataset_store  # type: ignore[attr-defined]
    return RefreshScheduler(tmp_path / "planifs.json", store, refresher, is_online=lambda: online, clock=clock, tz=UTC)


def tick(scheduler: RefreshScheduler) -> list:
    """Un passage de l'ordonnanceur, exécutions comprises."""

    async def go() -> list:
        tasks = await scheduler.tick()
        return [await t for t in tasks]

    return asyncio.run(go())


# --- Échéances --------------------------------------------------------------------------------


def test_next_run_interval_and_daily() -> None:
    t = datetime(2026, 10, 19, 6, 30, tzinfo=UTC)
    assert next_run(RefreshSchedule(), t) is None
    assert next_run(RefreshSchedule(mode="interval", every=15, unit="minutes"), t) == t + timedelta(minutes=15)
    assert next_run(RefreshSchedule(mode="interval", every=2, unit="hours"), t) == t + timedelta(hours=2)
    daily = RefreshSchedule(mode="daily", at="07:00")
    assert next_run(daily, t, UTC) == datetime(2026, 10, 19, 7, 0, tzinfo=UTC)
    assert next_run(daily, datetime(2026, 10, 19, 7, 0, tzinfo=UTC), UTC) == datetime(2026, 10, 20, 7, 0, tzinfo=UTC)
    # Heure locale : 07:00 à Paris (UTC+2) = 05:00 UTC.
    assert next_run(daily, t, PARIS_ETE) == datetime(2026, 10, 20, 5, 0, tzinfo=UTC)


def test_schedule_validation() -> None:
    with pytest.raises(ValueError):
        RefreshSchedule(mode="daily", at="25:00")
    with pytest.raises(ValueError, match="une semaine"):
        RefreshSchedule(mode="interval", every=200, unit="hours")


# --- Ordonnanceur -----------------------------------------------------------------------------


def test_interval_runs_when_due_and_logs(client: TestClient, tmp_path: Path) -> None:
    store = client.app.state.dataset_store  # type: ignore[attr-defined]
    ds = add_origin_dataset(store)
    calls: list[str] = []

    def refresher(d: StoredDataset) -> StoredDataset:
        calls.append(d.id)
        return d

    clock = Clock(datetime(2026, 10, 19, 8, 0, tzinfo=UTC))
    sched = make(client, tmp_path, refresher, clock)
    seen: list[str] = []

    async def listener(dataset_id: str) -> None:
        seen.append(dataset_id)

    sched.on_refreshed(listener)
    state = sched.set_schedule(ds.id, RefreshSchedule(mode="interval", every=30, unit="minutes"))
    assert state.next_run == clock.now + timedelta(minutes=30)

    clock.advance(minutes=29)
    assert tick(sched) == [] and calls == []
    clock.advance(minutes=1)
    runs = tick(sched)
    assert [r.status for r in runs] == ["success"] and runs[0].rows == 2 and runs[0].trigger == "schedule"
    assert calls == [ds.id] and seen == [ds.id]
    # La suivante est comptée depuis ce déclenchement.
    assert sched.get(ds.id).next_run == clock.now + timedelta(minutes=30)
    clock.advance(minutes=10)
    assert tick(sched) == []
    # Journal persistant (le plus récent d'abord à la lecture).
    raw = json.loads((tmp_path / "planifs.json").read_text(encoding="utf-8"))
    assert raw["datasets"][ds.id]["runs"][0]["status"] == "success"
    assert sched.get(ds.id).runs[0].rows == 2


def test_missed_run_is_caught_up_once(client: TestClient, tmp_path: Path) -> None:
    ds = add_origin_dataset(client.app.state.dataset_store)  # type: ignore[attr-defined]
    calls: list[str] = []
    clock = Clock(datetime(2026, 10, 19, 8, 0, tzinfo=UTC))
    sched = make(client, tmp_path, lambda d: calls.append(d.id) or d, clock)
    sched.set_schedule(ds.id, RefreshSchedule(mode="daily", at="07:00"))
    clock.advance(days=3)  # application fermée trois jours
    assert len(tick(sched)) == 1
    assert tick(sched) == []
    assert sched.get(ds.id).next_run == datetime(2026, 10, 23, 7, 0, tzinfo=UTC)


def test_one_run_at_a_time_per_dataset(client: TestClient, tmp_path: Path) -> None:
    ds = add_origin_dataset(client.app.state.dataset_store)  # type: ignore[attr-defined]
    started, release = threading.Event(), threading.Event()

    def slow(d: StoredDataset) -> StoredDataset:
        started.set()
        release.wait(5)
        return d

    sched = make(client, tmp_path, slow, Clock(datetime(2026, 10, 19, tzinfo=UTC)))

    async def go() -> tuple:
        first = asyncio.create_task(sched.run(ds.id, "manual"))
        await asyncio.to_thread(started.wait, 5)
        assert sched.is_running(ds.id) and sched.get(ds.id).running
        second = await sched.run(ds.id, "manual")
        with pytest.raises(ConnectorError) as busy:
            await sched.run(ds.id, "manual", raise_errors=True)
        release.set()
        return await first, second, busy.value.status_code

    first, second, code = asyncio.run(go())
    assert first.status == "success"
    assert second.status == "skipped" and "en cours" in (second.message or "")
    assert code == 409
    assert not sched.is_running(ds.id)


def test_sharepoint_skipped_offline(client: TestClient, tmp_path: Path) -> None:
    ds = add_origin_dataset(client.app.state.dataset_store, kind="sharepoint")  # type: ignore[attr-defined]
    calls: list[str] = []
    sched = make(client, tmp_path, lambda d: calls.append(d.id) or d, Clock(datetime(2026, 10, 19, tzinfo=UTC)))
    run = asyncio.run(sched.run(ds.id, "schedule"))
    assert run.status == "skipped" and "En ligne" in (run.message or "") and calls == []
    assert sched.get(ds.id).needs_online is True
    online = make(client, tmp_path, lambda d: calls.append(d.id) or d, Clock(datetime(2026, 10, 19, tzinfo=UTC)), True)
    assert asyncio.run(online.run(ds.id, "schedule")).status == "success"


def test_errors_are_logged_and_journal_is_bounded(client: TestClient, tmp_path: Path) -> None:
    ds = add_origin_dataset(client.app.state.dataset_store)  # type: ignore[attr-defined]
    errors = iter(
        [
            ConnectorError("Serveur injoignable."),
            ConnectorError("Mode hors ligne : adresse Internet.", 403),
            ModelError([ModelIssue(kind="column", name="marge", error="Champ inconnu : ca")]),
            RuntimeError("panne du pilote"),
        ]
    )

    def failing(d: StoredDataset) -> StoredDataset:
        raise next(errors)

    sched = make(client, tmp_path, failing, Clock(datetime(2026, 10, 19, tzinfo=UTC)))
    runs = [asyncio.run(sched.run(ds.id, "schedule")) for _ in range(4)]
    assert [r.status for r in runs] == ["error", "skipped", "error", "error"]
    assert "modèle" in (runs[2].message or "") and "marge" in (runs[2].message or "")
    assert runs[3].message == "panne du pilote"
    ok = make(client, tmp_path, lambda d: d, Clock(datetime(2026, 10, 19, tzinfo=UTC)))
    for _ in range(MAX_RUNS + 5):
        asyncio.run(ok.run(ds.id, "manual"))
    assert len(ok.get(ds.id).runs) == MAX_RUNS


def test_deleted_dataset_schedule_is_forgotten(client: TestClient, tmp_path: Path) -> None:
    store = client.app.state.dataset_store  # type: ignore[attr-defined]
    ds = add_origin_dataset(store)
    clock = Clock(datetime(2026, 10, 19, tzinfo=UTC))
    sched = make(client, tmp_path, lambda d: d, clock)
    sched.set_schedule(ds.id, RefreshSchedule(mode="interval", every=1, unit="minutes"))
    store.remove(ds.id)
    clock.advance(minutes=5)
    assert tick(sched) == []
    assert ds.id not in json.loads((tmp_path / "planifs.json").read_text(encoding="utf-8"))["datasets"]


# --- API --------------------------------------------------------------------------------------


def test_schedule_api_with_sqlite(client: TestClient, base: Path, settings) -> None:
    ds = import_sqlite(client, base)
    listed = client.get("/api/refresh").json()
    assert [s["dataset_id"] for s in listed] == [ds["id"]] and listed[0]["schedule"]["mode"] == "off"

    r = client.put(f"/api/refresh/{ds['id']}", json={"mode": "daily", "at": "06:45"})
    assert r.status_code == 200 and r.json()["next_run"] is not None
    stored = json.loads((settings.data_dir / "schedules.json").read_text())["datasets"][ds["id"]]
    assert stored["schedule"]["at"] == "06:45"
    assert client.put(f"/api/refresh/{ds['id']}", json={"mode": "daily", "at": "7h"}).status_code == 422

    con = sqlite3.connect(base)
    con.execute("INSERT INTO ventes VALUES ('Est', 1.0)")
    con.commit()
    con.close()
    before = client.get("/api/refresh/versions").json()[ds["id"]]
    run = client.post(f"/api/refresh/{ds['id']}/run")
    assert run.status_code == 200 and run.json()["status"] == "success" and run.json()["rows"] == 3
    assert client.get("/api/refresh/versions").json()[ds["id"]] > before
    state = client.get(f"/api/refresh/{ds['id']}").json()
    assert state["runs"][0]["trigger"] == "manual" and state["refreshed_at"] > ds["origin"]["refreshed_at"]

    # L'actualisation manuelle historique passe aussi par le journal.
    assert client.post(f"/api/datasets/{ds['id']}/refresh").status_code == 200
    assert len(client.get(f"/api/refresh/{ds['id']}").json()["runs"]) == 2

    # Source disparue : l'exécution est en erreur, journalisée, sans 500.
    base.unlink()
    failed = client.post(f"/api/refresh/{ds['id']}/run").json()
    assert failed["status"] == "error" and "introuvable" in failed["message"].lower()

    assert client.delete(f"/api/datasets/{ds['id']}").status_code == 204
    assert ds["id"] not in json.loads((settings.data_dir / "schedules.json").read_text())["datasets"]


def test_schedule_api_errors(client: TestClient) -> None:
    uploaded = client.post("/api/datasets", files={"file": ("v.csv", b"a;b\n1;2\n", "text/csv")}).json()
    assert client.get(f"/api/refresh/{uploaded['id']}").status_code == 422
    assert client.post(f"/api/refresh/{uploaded['id']}/run").status_code == 422
    assert client.get("/api/refresh/aaaaaaaaaaaa").status_code == 404
    assert client.get("/api/refresh").json() == []
