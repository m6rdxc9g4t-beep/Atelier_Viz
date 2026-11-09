"""Exemples de la suite : chargement des jeux et de l'alerte de chaque histoire, puis retrait."""

from pathlib import Path

from fastapi.testclient import TestClient

from app.core.config import Settings

EXEMPLES = Path(__file__).resolve().parents[2] / "exemples-suite"


def test_load_every_story_and_its_alert_fires(client: TestClient) -> None:
    histoires = client.get("/api/exemples-suite").json()
    assert len(histoires) >= 9
    for h in histoires:
        assert h["charge"] is False
        assert [e["app"] for e in h["parcours"]][2] == "viz"
        r = client.post(f"/api/exemples-suite/{h['id']}")
        assert r.status_code == 200, r.text
        res = r.json()
        assert len(res["datasets"]) == len(h["jeux"])
        assert res["alerte_declenchee"] is True, h["id"]
    assert all(h["charge"] for h in client.get("/api/exemples-suite").json())
    events = client.get("/api/atelier/events?types=viz.alert.triggered").json()["events"]
    assert len(events) == len(histoires)


def test_reload_does_not_duplicate_then_remove(client: TestClient) -> None:
    first = client.post("/api/exemples-suite/studio-garance").json()
    again = client.post("/api/exemples-suite/studio-garance").json()
    assert first["operations_id"] == again["operations_id"]
    assert first["alerte_id"] == again["alerte_id"]
    assert len(client.get("/api/alerts").json()) == 1
    other = client.post("/api/exemples-suite/immobilier-locatif").json()
    report = client.post("/api/reports", json={"name": first["rapport"], "dataset_id": first["operations_id"]})
    assert report.status_code == 201, report.text

    assert client.delete("/api/exemples-suite/studio-garance").status_code == 204
    ids = {d["id"] for d in client.get("/api/datasets").json()}
    assert first["operations_id"] not in ids and other["operations_id"] in ids
    assert [a["dataset_id"] for a in client.get("/api/alerts").json()] == [other["operations_id"]]
    assert all(r["name"] != first["rapport"] for r in client.get("/api/reports").json())


def test_unknown_story(client: TestClient) -> None:
    assert client.post("/api/exemples-suite/inconnue").status_code == 404
    assert client.delete("/api/exemples-suite/inconnue").status_code == 404
    assert client.post("/api/exemples-suite/..%2Fx").status_code in (404, 405)


def test_missing_directory_gives_empty_list(client: TestClient, settings: Settings, tmp_path: Path) -> None:
    settings.exemples_dir = tmp_path / "absent"
    assert client.get("/api/exemples-suite").json() == []


def test_examples_are_shipped() -> None:
    assert (EXEMPLES / "index.json").is_file()
