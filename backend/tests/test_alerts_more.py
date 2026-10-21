"""Alertes : variation depuis l'évaluation précédente, « pour chaque » valeur d'une dimension,
notifications système (simulées), webhook détaillé.
"""

import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.schemas.alert import AlertInput
from app.services.alerts import AlertError, AlertService
from app.services.system_notify import clean, system_notifier

CSV = b"region;ca\nNord;100\nSud;50\nNord;30\nEst;80\n"


def upload(client: TestClient) -> str:
    return client.post("/api/datasets", files={"file": ("v.csv", CSV, "text/csv")}).json()["id"]


def body(dataset_id: str, **extra) -> dict:
    base = {"name": "CA", "dataset_id": dataset_id, "measure": {"field": "ca", "agg": "sum"}, "threshold": 100}
    return {**base, "comparison": "gt", **extra}


@pytest.fixture
def env(client: TestClient, tmp_path: Path):
    app = client.app  # type: ignore[attr-defined]
    sent: list[tuple[str, str]] = []
    hooks: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        hooks.append(json.loads(request.content))
        return httpx.Response(200)

    svc = AlertService(
        tmp_path / "alertes.json",
        app.state.dataset_store,
        app.state.database,
        is_online=lambda: False,
        clock=lambda: datetime(2026, 10, 20, 8, 0, tzinfo=UTC),
        http_factory=lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        notifier=lambda title, message: sent.append((title, message)),
    )
    ds = upload(client)

    def replace(rows: list[tuple[str, float]]) -> None:
        store = app.state.dataset_store
        store.replace_data(store.get(ds), pd.DataFrame(rows, columns=["region", "ca"]), None)

    return svc, ds, replace, sent, hooks


def run(svc: AlertService, alert_id: str):
    return asyncio.run(svc.evaluate(alert_id, "refresh"))


def test_change_since_previous_evaluation(env) -> None:
    svc, ds, replace, sent, _ = env
    alert = svc.create(AlertInput.model_validate(body(ds, basis="change_pct", comparison="lte", threshold=-10)))
    first = run(svc, alert.id)
    assert first.history[0].value is None and first.last_raw == 260 and first.met is None
    assert "référence" in (first.history[0].note or "") and first.history[0].error is None
    replace([("Nord", 100), ("Sud", 100)])  # 200 : -23 %
    second = run(svc, alert.id)
    event = second.history[0]
    assert event.fired and event.raw == 200 and event.value == pytest.approx(-23.0769, rel=1e-3)
    assert second.last_raw == 200
    note = svc.notifications()[0]
    assert note.message == "CA (variation) : -23,08 % ≤ -10 %" and note.group is None
    assert sent == [("Atelier Viz · alerte", note.message)]
    # Plus de baisse : la condition n'est plus remplie (anti-rebond réarmé), aucune action.
    third = run(svc, alert.id)
    assert third.history[0].value == 0 and not third.history[0].met and len(sent) == 1
    absolute = svc.create(AlertInput.model_validate(body(ds, basis="change_abs", threshold=0)))
    run(svc, absolute.id)
    replace([("Nord", 300)])
    assert run(svc, absolute.id).history[0].value == 100


def test_for_each_value_of_a_dimension(env) -> None:
    svc, ds, replace, sent, hooks = env
    alert = svc.create(
        AlertInput.model_validate(body(ds, split_by="region", webhook={"url": "http://localhost:5678/hook"}))
    )
    first = run(svc, alert.id)  # Nord 130 > 100
    event = first.history[0]
    assert event.groups_count == 3 and [g.key for g in event.groups] == ["Nord"] and event.groups[0].fired
    assert first.met is True and first.groups["Sud"].met is False and first.groups["Nord"].value == 130
    assert [n.group for n in svc.notifications()] == ["Nord"]
    assert svc.notifications()[0].message == "CA · Nord : 130 > 100"
    assert hooks[0]["dimension"] == "region" and hooks[0]["valeurs"] == [
        {"valeur_dimension": "Nord", "valeur": 130.0, "mesure": 130.0}
    ]
    # Nord reste au-dessus (pas de nouvelle action) ; Sud franchit le seuil à son tour.
    replace([("Nord", 150), ("Sud", 120), ("Est", 10)])
    second = run(svc, alert.id)
    fired = [g.key for g in second.history[0].groups if g.fired]
    assert fired == ["Sud"] and [n.group for n in svc.notifications()] == ["Sud", "Nord"]
    assert len(sent) == 2 and len(hooks) == 2
    # Une nouvelle règle remet l'état de chaque valeur à zéro.
    updated = svc.update(alert.id, AlertInput.model_validate(body(ds, split_by="region", threshold=140)))
    assert updated.groups == {} and updated.met is None


def test_for_each_with_variation_and_errors(env) -> None:
    svc, ds, replace, sent, _ = env
    alert = svc.create(AlertInput.model_validate(body(ds, split_by="region", basis="change_pct", threshold=50)))
    first = run(svc, alert.id)
    assert first.history[0].groups == [] and first.groups["Nord"].raw == 130 and first.history[0].note
    replace([("Nord", 130), ("Sud", 90), ("Est", 80)])  # Sud +80 %
    second = run(svc, alert.id)
    assert [(g.key, round(g.value or 0)) for g in second.history[0].groups] == [("Sud", 80)]
    assert sent[-1][1] == "CA · Sud (variation) : +80 % > 50 %"
    with pytest.raises(AlertError, match="inconnu"):
        svc.create(AlertInput.model_validate(body(ds, split_by="pays")))


def test_system_notification_switch_and_cleaning(env) -> None:
    svc, ds, _, sent, _ = env
    quiet = svc.create(AlertInput.model_validate(body(ds, threshold=0, system=False)))
    run(svc, quiet.id)
    assert sent == [] and len(svc.notifications()) == 1
    assert clean("Ligne 1\nLigne 2‮\x00 fin", 80) == "Ligne 1 Ligne 2 fin"
    assert clean("x" * 300, 10) == "xxxxxxxxx…"
    assert system_notifier("win32") is None


def test_api_accepts_new_fields(client: TestClient) -> None:
    ds = upload(client)
    res = client.post("/api/alerts", json=body(ds, split_by="region", basis="change_abs"))
    assert res.status_code == 201, res.text
    data = res.json()
    assert data["split_by"] == "region" and data["basis"] == "change_abs" and data["system"] is True
    assert set(data["groups"]) == {"Nord", "Sud", "Est"}
    bad = client.post("/api/alerts", json=body(ds, notify=False, system=False))
    assert bad.status_code == 422


def test_system_status_routes(client: TestClient) -> None:
    # Les tests coupent les notifications système (conftest) : indisponibles, et l'essai n'envoie rien.
    assert client.get("/api/alerts/system").json() == {"available": False}
    assert client.post("/api/alerts/system/test").json() == {"available": False}
    sent: list[tuple[str, str]] = []
    client.app.state.alerts.notifier = lambda t, m: sent.append((t, m))  # type: ignore[attr-defined]
    assert client.post("/api/alerts/system/test").json() == {"available": True}
    assert sent and sent[0][0] == "Atelier Viz"
