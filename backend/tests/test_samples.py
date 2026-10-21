"""Jeux d'exemple : présents dans le dépôt, importés une seule fois."""

from pathlib import Path

from fastapi.testclient import TestClient

from app.core.config import Settings


def test_repository_ships_the_samples() -> None:
    folder = Settings(_env_file=None).samples_dir  # type: ignore[call-arg]
    assert {p.name for p in folder.iterdir()} >= {"ventes_2026.csv", "magasins.csv", "regions.csv"}


def test_import_is_idempotent(client: TestClient) -> None:
    assert {s["name"]: s["imported"] for s in client.get("/api/samples").json()} == {
        "magasins.csv": False,
        "regions.csv": False,
        "ventes_2026.csv": False,
    }
    first = client.post("/api/samples").json()
    assert sorted(first["imported"]) == ["magasins.csv", "regions.csv", "ventes_2026.csv"]
    ventes = next(d for d in first["datasets"] if d["name"] == "ventes_2026.csv")
    assert ventes["rows"] == 573
    again = client.post("/api/samples").json()
    assert again["imported"] == [] and {d["id"] for d in again["datasets"]} == {d["id"] for d in first["datasets"]}
    assert len(client.get("/api/datasets").json()) == 3
    # Exemple de modèle en étoile : ventes et magasins sont reliés à la table des régions.
    profile = client.get(f"/api/datasets/{ventes['id']}").json()
    assert [r["name"] for r in profile["model"]["relations"]] == ["regions"]
    assert {"regions.responsable", "regions.objectif_ca_2026"} <= {c["name"] for c in profile["columns"]}
    assert all(s["imported"] for s in client.get("/api/samples").json())


def test_missing_folder_is_harmless(settings: Settings, tmp_path: Path) -> None:
    from main import create_app

    settings.samples_dir = tmp_path / "absent"
    with TestClient(create_app(settings)) as c:
        assert c.get("/api/samples").json() == []
        assert c.post("/api/samples").json() == {"datasets": [], "imported": []}
