"""Rapports, préférences (mode en ligne) et webhooks des boutons."""

import asyncio
import json
import socket

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
    assert created["pages"] == [
        {"id": "p1", "name": "Page 1", "visuals": [], "filters": [], "size": {"width": 1280, "height": 720}}
    ]

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


DEFAULT_PREFS = {"online_mode": False, "ai_provider": "auto", "claude_model": "sonnet", "ollama_model": None}


def test_settings_persist(client: TestClient, settings) -> None:
    assert client.get("/api/settings").json() == DEFAULT_PREFS
    client.put("/api/settings", json={"online_mode": True})
    assert json.loads((settings.data_dir / "settings.json").read_text())["online_mode"] is True


def test_settings_partial_update_keeps_other_choices(client: TestClient, settings) -> None:
    """Moteur et modèles mémorisés (docs/SUITE.md §5.2) ; un PUT partiel ne remet rien à zéro."""
    choices = {"ai_provider": "anthropic", "claude_model": "opus", "ollama_model": "qwen3:8b"}
    body = client.put("/api/settings", json=choices)
    assert body.status_code == 200
    assert client.put("/api/settings", json={"online_mode": True}).json() == {
        "online_mode": True,
        "ai_provider": "anthropic",
        "claude_model": "opus",
        "ollama_model": "qwen3:8b",
    }
    on_disk = json.loads((settings.data_dir / "settings.json").read_text())
    assert on_disk["claude_model"] == "opus" and on_disk["ollama_model"] == "qwen3:8b"
    # null = revenir au modèle Ollama de la configuration
    assert client.put("/api/settings", json={"ollama_model": None}).json()["ollama_model"] is None


@pytest.mark.parametrize(
    "body", [{"claude_model": "gpt"}, {"ai_provider": "openai"}, {"ollama_model": ""}, {"online_mode": "peut-être"}]
)
def test_settings_rejects_unknown_choices(client: TestClient, body: dict) -> None:
    assert client.put("/api/settings", json=body).status_code == 422
    assert client.get("/api/settings").json() == DEFAULT_PREFS


def test_settings_file_from_older_version_is_read(settings) -> None:
    from app.services.preferences import PreferencesStore

    (settings.data_dir / "settings.json").write_text('{"online_mode": true}', encoding="utf-8")
    prefs = PreferencesStore(settings.data_dir / "settings.json").get()
    assert prefs.online_mode is True and prefs.claude_model == "sonnet" and prefs.ai_provider == "auto"


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


def _fake_dns(monkeypatch: pytest.MonkeyPatch, answers: dict[str, list[list[str]]]) -> list[str]:
    """Résolveur simulé : chaque appel pour un nom consomme la réponse suivante (rebinding)."""
    asked: list[str] = []

    def getaddrinfo(host, *args, **kwargs):  # noqa: ANN001, ANN202
        asked.append(host)
        ips = answers[host].pop(0) if len(answers[host]) > 1 else answers[host][0]
        return [(socket.AF_INET6 if ":" in ip else socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 0)) for ip in ips]

    monkeypatch.setattr(socket, "getaddrinfo", getaddrinfo)
    return asked


def test_offline_webhook_connects_to_the_validated_ip(monkeypatch: pytest.MonkeyPatch) -> None:
    # 1re résolution : réseau privé (validée) ; une 2e résolution renverrait une adresse publique.
    asked = _fake_dns(monkeypatch, {"n8n.maison.lan": [["192.168.1.20"], ["8.8.8.8"]]})
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, text="ok")

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    res = asyncio.run(
        call_webhook(
            WebhookRequest(url="https://n8n.maison.lan:8443/webhook/x?a=1", payload={"k": "v"}),
            online=False,
            client=client,
        )
    )
    assert res.ok and asked == ["n8n.maison.lan"]  # une seule résolution
    sent = seen[0]
    assert sent.url.host == "192.168.1.20" and sent.url.port == 8443 and sent.url.path == "/webhook/x"
    assert sent.url.params["a"] == "1"
    assert sent.headers["host"] == "n8n.maison.lan:8443"  # hôte virtuel conservé
    assert sent.extensions["sni_hostname"] == "n8n.maison.lan"  # certificat vérifié pour le nom
    assert json.loads(sent.content) == {"k": "v"}


def test_offline_webhook_get_and_ip_literal_not_rewritten(monkeypatch: pytest.MonkeyPatch) -> None:
    asked = _fake_dns(monkeypatch, {})
    seen: list[httpx.Request] = []
    client = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: seen.append(r) or httpx.Response(204)))
    res = asyncio.run(
        call_webhook(
            WebhookRequest(url="http://127.0.0.1:5678/hook", method="GET", payload={"region": "Nord"}),
            online=False,
            client=client,
        )
    )
    assert res.status_code == 204 and asked == []  # littéral IP : aucune résolution
    assert seen[0].url == httpx.URL("http://127.0.0.1:5678/hook?region=Nord")
    assert "sni_hostname" not in seen[0].extensions


def test_offline_refuses_names_with_any_public_address(monkeypatch: pytest.MonkeyPatch) -> None:
    _fake_dns(monkeypatch, {"mixte.exemple": [["192.168.1.20", "8.8.8.8"]], "public.exemple": [["8.8.8.8"]]})
    for host in ("mixte.exemple", "public.exemple"):
        assert not is_local_host(host)
        with pytest.raises(ActionError) as info:
            asyncio.run(call_webhook(WebhookRequest(url=f"http://{host}/hook"), online=False))
        assert info.value.status_code == 403


def test_offline_localhost_keeps_its_name(monkeypatch: pytest.MonkeyPatch) -> None:
    asked = _fake_dns(monkeypatch, {})
    seen: list[httpx.Request] = []
    client = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: seen.append(r) or httpx.Response(200)))
    asyncio.run(call_webhook(WebhookRequest(url="http://localhost:5678/hook"), online=False, client=client))
    assert asked == [] and seen[0].url.host == "localhost"  # résolu par la machine : repli IPv4 / IPv6 gardé


def test_online_webhook_is_not_pinned(monkeypatch: pytest.MonkeyPatch) -> None:
    asked = _fake_dns(monkeypatch, {})
    seen: list[httpx.Request] = []
    client = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: seen.append(r) or httpx.Response(200)))
    asyncio.run(call_webhook(WebhookRequest(url="https://hooks.exemple.fr/x"), online=True, client=client))
    assert asked == [] and seen[0].url.host == "hooks.exemple.fr"
