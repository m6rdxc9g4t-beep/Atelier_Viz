"""Nœud Atelier : actions d'écriture (rapports, alertes) et flux poussé des événements (SSE)."""

import asyncio
import json
from typing import Any

from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator

from app.services.atelier.journal import EventJournal
from app.services.atelier.stream import event_stream, frame
from tests.test_atelier_node import node, upload  # noqa: F401 — fixture réutilisée


def manifest_action(client: TestClient, action_id: str) -> dict[str, Any]:
    return next(a for a in client.get("/api/atelier/manifest").json()["actions"] if a["id"] == action_id)


def report_on(client: TestClient, dataset_id: str) -> dict[str, Any]:
    r = client.post("/api/reports", json={"name": "Modèle mensuel", "dataset_id": dataset_id}).json()
    body = {
        "name": "Modèle mensuel",
        "dataset_id": dataset_id,
        "pages": [
            {
                "id": "p1",
                "name": "Vue",
                "visuals": [
                    {
                        "id": "v1",
                        "type": "column",
                        "layout": {"x": 0, "y": 0, "w": 400, "h": 300},
                        "dataset_id": dataset_id,
                        "roles": {"category": [{"field": "region"}], "values": [{"field": "CA", "agg": "sum"}]},
                    }
                ],
            }
        ],
        "bookmarks": [
            {"id": "b1", "name": "Équipe", "pages": {}},
            {"id": "b2", "name": "À moi", "personal": True, "pages": {}},
        ],
    }
    assert client.put(f"/api/reports/{r['id']}", json=body).status_code == 200
    return r


def test_reports_duplicate_rebinds_and_is_idempotent(node: TestClient) -> None:  # noqa: F811
    ds = upload(node)
    other = upload(node, b"region;Montant\nEst;5\n", "autre.csv")
    model = report_on(node, ds["id"])
    action = manifest_action(node, "reports.duplicate")
    assert action["kind"] == "write" and action["idempotency"] == "header"

    body = {"report_id": model["id"], "name": "Ventes novembre", "dataset_id": other["id"]}
    Draft202012Validator(action["input_schema"]).validate(body)
    r = node.post(action["http"]["path"], json=body, headers={"Idempotency-Key": "nexus:run1:dup"})
    assert r.status_code == 201, r.text
    out = r.json()
    Draft202012Validator(action["output"]["schema"]).validate(out)
    assert out["rebound_visuals"] == 1 and out["missing_fields"] == ["CA"]
    copy = node.get(f"/api/reports/{out['report_id']}").json()
    assert copy["name"] == "Ventes novembre" and copy["dataset_id"] == other["id"]
    assert copy["pages"][0]["visuals"][0]["dataset_id"] == other["id"]
    assert [b["id"] for b in copy["bookmarks"]] == ["b1"]  # signet personnel : ne suit pas

    again = node.post(action["http"]["path"], json=body, headers={"Idempotency-Key": "nexus:run1:dup"})
    assert again.status_code == 201 and again.headers["Idempotency-Replayed"] == "true" and again.json() == out
    assert len(node.get("/api/reports").json()) == 2
    reused = node.post(
        action["http"]["path"], json={**body, "name": "Autre"}, headers={"Idempotency-Key": "nexus:run1:dup"}
    )
    assert reused.status_code == 409 and reused.json()["code"] == "IDEMPOTENCY_KEY_REUSED"

    missing = node.post(action["http"]["path"], json={"report_id": "0" * 12})
    assert missing.status_code == 404 and missing.json()["code"] == "NOT_FOUND"
    events = node.get("/api/atelier/events", params={"types": "viz.report.saved"}).json()["events"]
    assert any(e["subject"]["id"] == out["report_id"] for e in events)


def test_alert_actions(node: TestClient) -> None:  # noqa: F811
    ds = upload(node)
    create = manifest_action(node, "alerts.create")
    body = {
        "name": "CA élevé",
        "dataset_id": ds["id"],
        "measure": {"field": "CA", "agg": "sum"},
        "threshold": 150,
        "system": False,
    }
    Draft202012Validator(create["input_schema"]).validate(body)
    r = node.post(create["http"]["path"], json=body, headers={"Idempotency-Key": "k1"})
    assert r.status_code == 201
    alert = r.json()
    Draft202012Validator(create["output"]["schema"]).validate(alert)
    assert node.post(create["http"]["path"], json=body, headers={"Idempotency-Key": "k1"}).json()["id"] == alert["id"]
    assert len(node.get("/api/alerts").json()) == 1
    bad = node.post(create["http"]["path"], json={**body, "measure": {"field": "inconnu", "agg": "sum"}})
    assert bad.status_code in {404, 422} and bad.json()["code"] in {"NOT_FOUND", "VALIDATION"}

    path = manifest_action(node, "alerts.set_enabled")["http"]["path"].replace("{alert_id}", alert["id"])
    paused = node.post(path, json={"alert_id": alert["id"], "enabled": False}).json()
    assert paused["enabled"] is False and paused["name"] == "CA élevé"
    assert node.post(path, json={"alert_id": "autre", "enabled": True}).json()["code"] == "VALIDATION"
    node.post(path, json={"alert_id": alert["id"], "enabled": True})

    evaluate = manifest_action(node, "alerts.evaluate")["http"]["path"].replace("{alert_id}", alert["id"])
    evaluated = node.post(evaluate).json()
    assert evaluated["history"][0]["trigger"] == "manual" and evaluated["history"][0]["fired"] is True
    assert node.post(evaluate.replace(alert["id"], "absente")).json()["code"] == "NOT_FOUND"

    delete = manifest_action(node, "alerts.delete")
    assert delete["kind"] == "destructive" and delete["http"]["method"] == "DELETE"
    assert node.delete(delete["http"]["path"].replace("{alert_id}", alert["id"])).status_code == 204
    assert node.get("/api/alerts").json() == []


def test_event_stream_generator(tmp_path) -> None:  # type: ignore[no-untyped-def]
    journal = EventJournal(tmp_path / "events.jsonl")
    for i in range(3):
        journal.emit("viz.dataset.deleted", f"d{i}", f"Jeu {i}", {})
    ticks = iter([0.0, 0.0, 0.5, 2.0, 5.0])
    sleeps: list[float] = []

    async def collect() -> list[str]:
        async def no() -> bool:
            return False

        async def sleep(s: float) -> None:
            sleeps.append(s)
            if len(sleeps) == 1:  # un nouvel événement arrive pendant l'attente
                journal.emit("viz.dataset.deleted", "d9", "Nouveau", {})

        return [m async for m in event_stream(journal, 1, None, 1.0, no, sleep, lambda: next(ticks))]

    messages = asyncio.run(collect())
    assert messages[0].startswith("retry:")
    ids = [m.split("\n")[0] for m in messages if m.startswith("id:")]
    assert ids == ["id: 2", "id: 3", "id: 4"]  # après since=1, puis l'événement arrivé en direct
    data = json.loads(messages[1].split("data: ", 1)[1])
    assert data["seq"] == 2 and data["type"] == "viz.dataset.deleted"
    assert frame("gap", {"since": 9}).startswith("event: gap\n")


def test_event_stream_route(node: TestClient) -> None:  # noqa: F811
    upload(node)
    with node.stream("GET", "/api/atelier/events/stream", params={"since": 0, "timeout": 0}) as r:
        assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
        text = "".join(r.iter_text())
    assert "event: viz.dataset.created" in text and "id: 1" in text
    # Reprise par Last-Event-ID : rien de nouveau.
    with node.stream("GET", "/api/atelier/events/stream", params={"timeout": 0}, headers={"Last-Event-ID": "1"}) as r:
        assert "event: viz.dataset.created" not in "".join(r.iter_text())
    # Seq inconnu (journal remplacé) : « gap » signalé.
    with node.stream("GET", "/api/atelier/events/stream", params={"since": 999, "timeout": 0}) as r:
        assert "event: gap" in "".join(r.iter_text())
    # Reconnexion d'un EventSource ouvert sur ?since=0 : Last-Event-ID l'emporte, rien n'est rejoué.
    with node.stream(
        "GET", "/api/atelier/events/stream", params={"since": 0, "timeout": 0}, headers={"Last-Event-ID": "1"}
    ) as r:
        assert "event: viz.dataset.created" not in "".join(r.iter_text())


def test_event_stream_after_reset_resumes_at_the_real_seq(tmp_path) -> None:  # type: ignore[no-untyped-def]
    """`since` au-delà du dernier seq (journal remis à zéro) : gap, puis les nouveaux événements arrivent."""
    journal = EventJournal(tmp_path / "events.jsonl")
    journal.emit("viz.dataset.deleted", "d1", "Jeu 1", {})
    ticks = iter([0.0, 0.0, 0.5, 2.0, 5.0])
    calls: list[float] = []

    async def collect() -> list[str]:
        async def no() -> bool:
            return False

        async def sleep(s: float) -> None:
            calls.append(s)
            if len(calls) == 1:
                journal.emit("viz.dataset.deleted", "d2", "Nouveau", {})

        return [m async for m in event_stream(journal, 500, None, 1.0, no, sleep, lambda: next(ticks))]

    messages = asyncio.run(collect())
    assert any(m.startswith("event: gap") for m in messages)
    assert [m.split("\n")[0] for m in messages if m.startswith("id:")] == ["id: 2"]
