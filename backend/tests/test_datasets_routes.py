"""Endpoints /api/datasets et contexte de données pour l'IA."""

from fastapi.testclient import TestClient

from app.services.ai import AIService
from tests.conftest import FakeProvider

CSV = b"date;region;montant\n05/01/2026;Nord;1 200,50\n06/01/2026;Sud;800,00\n07/01/2026;Nord;\n"


def upload(client: TestClient, name: str = "ventes.csv", content: bytes = CSV):
    return client.post("/api/datasets", files={"file": (name, content, "text/csv")})


def test_upload_returns_profile(client: TestClient) -> None:
    response = upload(client)
    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "ventes.csv" and body["rows"] == 3 and body["columns_count"] == 3
    montant = next(c for c in body["columns"] if c["name"] == "montant")
    assert montant == {
        "name": "montant",
        "type": "number",
        "nulls": 1,
        "distinct": 2,
        "min": 800.0,
        "max": 1200.5,
        "mean": 1000.25,
        "top_values": [],
        "calculated": False,
        "expression": None,
    }
    assert body["model"] == {"columns": [], "measures": []}
    assert body["sample"][0] == {"date": "2026-01-05", "region": "Nord", "montant": 1200.5}


def test_list_get_rows_delete(client: TestClient) -> None:
    dataset_id = upload(client).json()["id"]

    assert [d["id"] for d in client.get("/api/datasets").json()] == [dataset_id]
    assert client.get(f"/api/datasets/{dataset_id}").json()["id"] == dataset_id

    page = client.get(f"/api/datasets/{dataset_id}/rows", params={"offset": 1, "limit": 1}).json()
    assert page["total"] == 3 and page["rows"] == [{"date": "2026-01-06", "region": "Sud", "montant": 800.0}]

    assert client.delete(f"/api/datasets/{dataset_id}").status_code == 204
    assert client.get(f"/api/datasets/{dataset_id}").status_code == 404


def test_invalid_file_is_422(client: TestClient) -> None:
    response = upload(client, "notes.pdf", b"%PDF-1.7")
    assert response.status_code == 422
    assert "non pris en charge" in response.json()["detail"]


def test_too_large_is_413(client: TestClient) -> None:
    client.app.state.settings.max_upload_mb = 0  # type: ignore[attr-defined]
    assert upload(client).status_code == 413


def test_chat_with_dataset_sends_schema_not_full_data(client: TestClient, override_ai) -> None:
    dataset_id = upload(client).json()["id"]
    ollama = FakeProvider("ollama")
    systems: list[str | None] = []
    sent: list[str] = []

    async def spy_chat(messages, system=None):  # type: ignore[no-untyped-def]
        systems.append(system)
        sent.append(messages[-1].content)
        return "ok"

    ollama.chat = spy_chat  # type: ignore[method-assign]
    override_ai(AIService(ollama, FakeProvider("anthropic")))  # type: ignore[arg-type]

    response = client.post(
        "/api/ai/chat",
        json={
            "messages": [{"role": "user", "content": "Quel graphique ?"}],
            "provider": "ollama",
            "system": "Consigne",
            "dataset_id": dataset_id,
        },
    )
    assert response.status_code == 200
    # Le prompt système garde la consigne seule ; le schéma et l'échantillon sont dans la question (§5.3).
    assert systems[0] == "Consigne"
    question = sent[0]
    assert "montant (type number" in question and "3 lignes" in question
    assert question.endswith("Quel graphique ?")


def test_chat_with_unknown_dataset_is_404(client: TestClient) -> None:
    response = client.post(
        "/api/ai/chat", json={"messages": [{"role": "user", "content": "x"}], "dataset_id": "inconnu"}
    )
    assert response.status_code == 404
