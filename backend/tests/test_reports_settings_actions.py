"""Rapports, préférences (mode en ligne) et webhooks des boutons."""

import asyncio
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.services.actions import ActionError, WebhookRequest, call_webhook, is_local_host

VISUAL = {
    "id": "v1",
    "type": "column",
    "title": "CA par région",
    "layout": {"x": 0, "y": 0, "w": 12, "h": 8},
    "dataset_id": "abc123abc123",
    "roles": {"category": [{"field": "region"}], "values": [{"field": "ca", "agg": "sum"}]},
    "options": {"stacked": False},
}


def test_report_crud_roundtrip(client: TestClient, settings) -> None:
    created = client.post("/api/reports", json={"name": "Ventes"}).json()
    assert created["pages"] == [{"id": "p1", "name": "Page 1", "visuals": [], "filters": []}]

    body = {
        "name": "Ventes 2026",
        "dataset_id": None,
        "theme": {},
        "pages": [{"id": "p1", "name": "Synthèse", "visuals": [VISUAL], "filters": []}],
    }
    saved = client.put(f"/api/reports/{created['id']}", json=body)
    assert saved.status_code == 200
    assert saved.json()["updated_at"] >= created["updated_at"]

    on_disk = json.loads((settings.data_dir / "reports" / f"{created['id']}.json").read_text(encoding="utf-8"))
    assert on_disk["pages"][0]["visuals"][0]["roles"]["values"][0] == {
        "field": "ca",
        "agg": "sum",
        "bin": None,
        "label": None,
    }

    summaries = client.get("/api/reports").json()
    assert summaries[0]["name"] == "Ventes 2026" and summaries[0]["visuals"] == 1
    assert client.get(f"/api/reports/{created['id']}").json()["pages"][0]["name"] == "Synthèse"
    assert client.delete(f"/api/reports/{created['id']}").status_code == 204
    assert client.get(f"/api/reports/{created['id']}").status_code == 404


def test_report_validation(client: TestClient) -> None:
    report_id = client.post("/api/reports", json={"name": "R"}).json()["id"]
    bad = {"name": "R", "pages": [{"id": "p1", "name": "P", "visuals": [{**VISUAL, "type": "inconnu"}]}]}
    assert client.put(f"/api/reports/{report_id}", json=bad).status_code == 422
    assert client.get("/api/reports/../../etc").status_code == 404


def test_settings_persist(client: TestClient, settings) -> None:
    assert client.get("/api/settings").json() == {"online_mode": False}
    client.put("/api/settings", json={"online_mode": True})
    assert json.loads((settings.data_dir / "settings.json").read_text())["online_mode"] is True


def test_query_endpoint(client: TestClient) -> None:
    csv = b"region;ca\nNord;10\nSud;5\nNord;1\n"
    dataset_id = client.post("/api/datasets", files={"file": ("v.csv", csv, "text/csv")}).json()["id"]
    res = client.post(
        "/api/query",
        json={"dataset_id": dataset_id, "dimensions": [{"field": "region"}], "measures": [{"field": "ca"}]},
    )
    assert res.status_code == 200
    assert res.json()["rows"] == [["Nord", 11.0], ["Sud", 5.0]]
    bad = client.post("/api/query", json={"dataset_id": dataset_id, "measures": [{"field": "nope"}]})
    assert bad.status_code == 422 and "inconnu" in bad.json()["detail"]


def test_local_hosts() -> None:
    assert is_local_host("localhost") and is_local_host("127.0.0.1") and is_local_host("192.168.1.20")
    assert not is_local_host("8.8.8.8")


@pytest.mark.parametrize(
    ("url", "online", "status"),
    [("ftp://x", True, 422), ("https://8.8.8.8/hook", False, 403)],
)
def test_webhook_rejections(url: str, online: bool, status: int) -> None:
    with pytest.raises(ActionError) as info:
        asyncio.run(call_webhook(WebhookRequest(url=url), online=online))
    assert info.value.status_code == status


def test_webhook_posts_payload() -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, text="reçu")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    res = asyncio.run(
        call_webhook(
            WebhookRequest(url="http://localhost:5678/webhook/rapport", payload={"region": "Nord"}),
            online=False,
            client=client,
        )
    )
    assert res.ok and res.body == "reçu" and seen["body"] == {"region": "Nord"}


def test_webhook_route_offline_blocks_internet(client: TestClient) -> None:
    res = client.post("/api/actions/webhook", json={"url": "https://8.8.8.8/hook"})
    assert res.status_code == 403 and "hors ligne" in res.json()["detail"]
