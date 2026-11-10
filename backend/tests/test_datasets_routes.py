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
        "related": None,
    }
    assert body["model"] == {"columns": [], "measures": [], "relations": []}
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


def test_awkward_but_valid_files_are_imported(client: TestClient) -> None:
    # Décalages horaires différents dans une colonne, tableaux dans un JSON : 201, jamais 500.
    stamps = b"quand;v\n2026-03-28T10:30:00+01:00;1\n2026-03-29T11:00:00+02:00;2\n"
    response = upload(client, "horodatages.csv", stamps)
    assert response.status_code == 201
    assert next(c for c in response.json()["columns"] if c["name"] == "quand")["type"] == "date"
    response = upload(client, "api.json", b'[{"id": 1, "tags": ["a", "b"]}, {"id": 2, "tags": []}]')
    assert response.status_code == 201
    tags = next(c for c in response.json()["columns"] if c["name"] == "tags")
    assert tags["type"] == "string" and tags["distinct"] == 2


def test_too_large_is_413(client: TestClient) -> None:
    client.app.state.settings.max_upload_mb = 0  # type: ignore[attr-defined]
    assert upload(client).status_code == 413


def replace(client: TestClient, dataset_id: str, content: bytes, name: str = "ventes_fevrier.csv"):
    return client.put(f"/api/datasets/{dataset_id}/data", files={"file": (name, content, "text/csv")})


def test_replace_data_keeps_the_dataset_its_model_and_its_alerts(client: TestClient) -> None:
    dataset_id = upload(client).json()["id"]
    model = {"columns": [], "measures": [{"name": "Total", "expression": "SUM(montant)"}]}
    assert client.put(f"/api/datasets/{dataset_id}/model", json=model).status_code == 200
    steps = {"steps": [{"kind": "filter", "column": "montant", "op": "not_null"}]}
    assert client.put(f"/api/datasets/{dataset_id}/steps", json=steps).status_code == 200
    alert = {
        "name": "Mois fort",
        "dataset_id": dataset_id,
        "measure": {"field": "montant", "agg": "sum"},
        "comparison": "gt",
        "threshold": 5000,
        "system": False,
    }
    alert_id = client.post("/api/alerts", json=alert).json()["id"]

    fresh = b"date;region;montant\n03/02/2026;Nord;4 000,00\n04/02/2026;Est;2 500,50\n05/02/2026;Sud;\n"
    response = replace(client, dataset_id, fresh)
    assert response.status_code == 200, response.text
    body = response.json()
    # Même jeu (identifiant et nom : les rapports restent branchés), nouvelles données, étapes rejouées.
    assert body["id"] == dataset_id and body["name"] == "ventes.csv" and body["rows"] == 2
    assert [m["name"] for m in body["model"]["measures"]] == ["Total"] and len(body["steps"]) == 1
    assert len(client.get("/api/datasets").json()) == 1
    query = {"dataset_id": dataset_id, "measures": [{"field": "Total", "agg": "calc"}]}
    assert client.post("/api/query", json=query).json()["rows"] == [[6500.5]]
    assert client.get(f"/api/alerts/{alert_id}").json()["met"] is True  # alertes du jeu réévaluées


def test_replace_data_refusals_change_nothing(client: TestClient) -> None:
    dataset_id = upload(client).json()["id"]
    model = {"columns": [{"name": "ttc", "expression": "montant * 1.2"}], "measures": []}
    assert client.put(f"/api/datasets/{dataset_id}/model", json=model).status_code == 200

    # Colonne utilisée par le modèle disparue : 409 avec le détail, rien n'a changé.
    response = replace(client, dataset_id, b"date;region;total\n03/02/2026;Nord;10\n")
    assert response.status_code == 409 and response.json()["detail"]["issues"][0]["name"] == "ttc"
    assert "rien n'a changé" in response.json()["detail"]["message"]
    assert client.get(f"/api/datasets/{dataset_id}").json()["rows"] == 3
    # Fichier illisible, jeu inconnu.
    assert replace(client, dataset_id, b"%PDF-1.7", "notes.pdf").status_code == 422
    assert replace(client, "0123456789ab", CSV).status_code == 404
    # Un jeu alimenté par un workflow (ou une connexion) se met à jour par sa source, pas par un fichier.
    table = {
        "format": "atelier-table/1",
        "name": "t",
        "columns": [{"key": "n", "label": "N", "type": "number"}],
        "rows": [{"n": 1}],
    }
    pushed = client.post("/api/atelier/datasets", json={"name": "Flux", "key": "nexus:flux", "table": table}).json()
    response = replace(client, pushed["dataset_id"], CSV)
    assert response.status_code == 409 and "workflow" in response.json()["detail"]
    assert client.get(f"/api/datasets/{pushed['dataset_id']}").json()["rows"] == 1
    # Limite de taille : la même que l'import.
    client.app.state.settings.max_upload_mb = 0  # type: ignore[attr-defined]
    assert replace(client, dataset_id, CSV).status_code == 413
    assert client.get(f"/api/datasets/{dataset_id}").json()["rows"] == 3


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
