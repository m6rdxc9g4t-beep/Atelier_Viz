"""Alertes sur seuil : mesure compilée par le moteur, anti-rebond, notifications, webhook (simulé),
évaluation après actualisation, politique réseau, API.
"""

import asyncio
import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.schemas.alert import AlertInput
from app.services.alerts import AlertError, AlertService, compare, format_number

CSV = b"region;ca;cout\nNord;100;60\nSud;50;45\nNord;30;10\n"


def upload(client: TestClient, content: bytes = CSV) -> str:
    return client.post("/api/datasets", files={"file": ("v.csv", content, "text/csv")}).json()["id"]


def alert_body(dataset_id: str, **extra) -> dict:
    return {
        "name": "CA élevé",
        "dataset_id": dataset_id,
        "measure": {"field": "ca", "agg": "sum"},
        "comparison": "gt",
        "threshold": 150,
        **extra,
    }


def service(client: TestClient, tmp_path: Path, handler=None, online: bool = False) -> AlertService:
    app = client.app  # type: ignore[attr-defined]
    factory = (lambda: httpx.AsyncClient(transport=httpx.MockTransport(handler))) if handler else None
    return AlertService(
        tmp_path / "alertes.json",
        app.state.dataset_store,
        app.state.database,
        is_online=lambda: online,
        clock=lambda: datetime(2026, 10, 19, 8, 0, tzinfo=UTC),
        http_factory=factory,
    )


def test_compare_and_format() -> None:
    assert compare(2, "gt", 1) and compare(1, "gte", 1) and compare(0, "lt", 1) and compare(1, "lte", 1)
    assert compare(0.1 + 0.2, "eq", 0.3) and compare(1, "neq", 2) and not compare(1, "neq", 1)
    assert format_number(1234567.5) == "1 234 567,5" and format_number(150) == "150"


def test_measure_uses_engine_with_filters_and_calculated_measures(client: TestClient, tmp_path: Path) -> None:
    ds = upload(client)
    model = {"columns": [], "measures": [{"name": "Marge", "expression": "SUM(ca) - SUM(cout)"}]}
    assert client.put(f"/api/datasets/{ds}/model", json=model).status_code == 200
    svc = service(client, tmp_path)
    assert svc.measure(AlertInput.model_validate(alert_body(ds))) == 180
    north = [{"field": "region", "op": "in", "values": ["Nord"]}]
    assert svc.measure(AlertInput.model_validate(alert_body(ds, filters=north))) == 130
    calc = alert_body(ds, measure={"field": "Marge", "agg": "calc"})
    assert svc.measure(AlertInput.model_validate(calc)) == 65
    count = alert_body(ds, measure={"field": None, "agg": "count"})
    assert svc.measure(AlertInput.model_validate(count)) == 3
    # Aucune chaîne SQL : un champ inconnu ou une injection est refusé par le moteur.
    with pytest.raises(AlertError, match="inconnu"):
        svc.measure(AlertInput.model_validate(alert_body(ds, measure={"field": 'ca"); DROP TABLE x; --'})))
    with pytest.raises(AlertError, match="numérique"):
        svc.measure(AlertInput.model_validate(alert_body(ds, measure={"field": "region", "agg": "sum"})))


def test_debounce_fires_on_crossing_only(client: TestClient, tmp_path: Path) -> None:
    ds = upload(client)
    svc = service(client, tmp_path)
    alert = svc.create(AlertInput.model_validate(alert_body(ds)))  # 180 > 150

    first = asyncio.run(svc.evaluate(alert.id, "manual"))
    assert first.met is True and first.history[0].fired and first.last_value == 180
    again = asyncio.run(svc.evaluate(alert.id, "manual"))
    assert again.history[0].met and not again.history[0].fired  # reste vraie : pas de nouveau déclenchement
    assert len(svc.notifications()) == 1

    # La condition redevient fausse, puis vraie : nouveau franchissement.
    svc.update(alert.id, AlertInput.model_validate(alert_body(ds, threshold=150)))  # même règle : état gardé
    assert svc.get(alert.id).met is True
    raised = svc.update(alert.id, AlertInput.model_validate(alert_body(ds, threshold=500)))  # règle changée
    assert raised.met is None
    assert asyncio.run(svc.evaluate(alert.id, "manual")).met is False
    svc.update(alert.id, AlertInput.model_validate(alert_body(ds, threshold=500, comparison="lt")))
    fired = asyncio.run(svc.evaluate(alert.id, "manual"))
    assert fired.history[0].fired and len(svc.notifications()) == 2
    note = svc.notifications()[0]
    assert note.message == "CA élevé : 180 < 500" and not note.read
    assert all(n.read for n in svc.mark_read([]))


def test_disabled_alert_never_fires_and_errors_keep_state(client: TestClient, tmp_path: Path) -> None:
    ds = upload(client)
    svc = service(client, tmp_path)
    off = svc.create(AlertInput.model_validate(alert_body(ds, enabled=False)))
    assert not asyncio.run(svc.evaluate(off.id, "manual")).history[0].fired
    empty = alert_body(ds, filters=[{"field": "region", "op": "in", "values": ["Ouest"]}])
    on = svc.create(AlertInput.model_validate(empty))
    res = asyncio.run(svc.evaluate(on.id, "manual"))
    assert res.met is None and "Aucune valeur" in (res.history[0].error or "")


def test_webhook_called_on_fire_and_offline_policy(client: TestClient, tmp_path: Path) -> None:
    ds = upload(client)
    seen: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return httpx.Response(200, text="ok")

    svc = service(client, tmp_path, handler)
    local = svc.create(
        AlertInput.model_validate(alert_body(ds, notify=False, webhook={"url": "http://localhost:5678/webhook/alerte"}))
    )
    res = asyncio.run(svc.evaluate(local.id, "refresh"))
    assert res.history[0].webhook_status == 200 and seen[0]["valeur"] == 180 and seen[0]["seuil"] == 150
    assert svc.notifications() == []  # notification décochée

    # Hors ligne, un webhook sur Internet est refusé (aucun appel), l'erreur est dans l'historique.
    public = svc.create(AlertInput.model_validate(alert_body(ds, webhook={"url": "https://8.8.8.8/hook"})))
    blocked = asyncio.run(svc.evaluate(public.id, "refresh"))
    assert blocked.history[0].fired and "hors ligne" in (blocked.history[0].webhook_error or "")
    assert len(seen) == 1 and len(svc.notifications()) == 1


def test_alert_input_requires_an_action() -> None:
    with pytest.raises(ValueError, match="au moins une action"):
        AlertInput.model_validate(alert_body("a" * 12, notify=False))


# --- API --------------------------------------------------------------------------------------


def test_alert_api_crud_evaluate_and_notifications(client: TestClient, settings) -> None:
    ds = upload(client)
    created = client.post("/api/alerts", json=alert_body(ds))
    assert created.status_code == 201, created.text
    alert = created.json()
    assert alert["met"] is True and alert["history"][0]["trigger"] == "created" and alert["history"][0]["fired"]
    assert client.get("/api/alerts").json()[0]["id"] == alert["id"]
    assert client.get(f"/api/alerts?dataset_id={ds}").json()[0]["id"] == alert["id"]
    assert client.get(f"/api/alerts/{alert['id']}").json()["name"] == "CA élevé"

    evaluated = client.post(f"/api/alerts/{alert['id']}/evaluate").json()
    assert evaluated["history"][0]["trigger"] == "manual" and not evaluated["history"][0]["fired"]

    notes = client.get("/api/alerts/notifications").json()
    assert len(notes) == 1 and notes[0]["read"] is False
    assert client.post("/api/alerts/notifications/read", json={"ids": [notes[0]["id"]]}).json()[0]["read"] is True

    updated = client.put(f"/api/alerts/{alert['id']}", json=alert_body(ds, name="CA", threshold=1000))
    assert updated.status_code == 200 and updated.json()["met"] is None
    on_disk = json.loads((settings.data_dir / "alerts.json").read_text(encoding="utf-8"))
    assert on_disk["alerts"][0]["threshold"] == 1000

    assert client.post("/api/alerts", json=alert_body(ds, measure={"field": "inconnu"})).status_code == 422
    assert client.post("/api/alerts", json=alert_body("b" * 12)).status_code == 404
    assert client.delete(f"/api/alerts/{alert['id']}").status_code == 204
    assert client.get(f"/api/alerts/{alert['id']}").status_code == 404
    assert client.post(f"/api/alerts/{alert['id']}/evaluate").status_code == 404


def test_alerts_evaluated_after_refresh_and_removed_with_dataset(client: TestClient, tmp_path: Path) -> None:
    path = tmp_path / "source.db"
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE ventes (region TEXT, ca REAL)")
    con.execute("INSERT INTO ventes VALUES ('Nord', 100)")
    con.commit()
    conn = client.post("/api/connections", json={"name": "B", "kind": "sqlite", "path": str(path)}).json()
    ds = client.post(f"/api/connections/{conn['id']}/import", json={"table": {"name": "ventes"}}).json()["id"]

    alert = client.post("/api/alerts", json=alert_body(ds)).json()
    assert alert["met"] is False and not alert["history"][0]["fired"]

    con.execute("INSERT INTO ventes VALUES ('Sud', 80)")
    con.commit()
    con.close()
    assert client.post(f"/api/refresh/{ds}/run").json()["status"] == "success"
    after = client.get(f"/api/alerts/{alert['id']}").json()
    assert after["met"] is True and after["history"][0]["trigger"] == "refresh" and after["history"][0]["fired"]
    assert client.get("/api/alerts/notifications").json()[0]["message"] == "CA élevé : 180 > 150"

    assert client.delete(f"/api/datasets/{ds}").status_code == 204
    assert client.get("/api/alerts").json() == []
