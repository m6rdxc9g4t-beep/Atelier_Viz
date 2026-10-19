"""Signets d'un rapport : schéma, enregistrement, migration tolérante des anciens rapports."""

import json

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from app.schemas.report import Bookmark, ReportBody

BOOKMARK = {
    "id": "b1",
    "name": "Occitanie",
    "page_id": "p1",
    "pages": {
        "p1": {
            "filters": [{"field": "annee", "op": "eq", "values": [2026]}],
            "visuals": {"s1": {"selected": ["Occitanie"], "range": [None, None]}, "c1": {"drill": {"level": 1}}},
        }
    },
    "selection": {"visual_id": "c1", "dataset_id": "abc123abc123", "filters": [], "keys": ["Toulouse"]},
}


def test_bookmark_schema_defaults_and_validation() -> None:
    b = Bookmark.model_validate(BOOKMARK)
    assert b.apply_page and b.apply_data
    assert b.pages["p1"].visuals["s1"].selected == ["Occitanie"]
    with pytest.raises(ValidationError):
        Bookmark.model_validate({**BOOKMARK, "name": ""})
    with pytest.raises(ValidationError):  # filtre invalide dans l'état capturé
        bad = {"field": "x", "op": "between", "values": [1]}
        Bookmark.model_validate({**BOOKMARK, "pages": {"p1": {"filters": [bad]}}})
    with pytest.raises(ValidationError, match="même identifiant"):
        ReportBody.model_validate({"name": "R", "bookmarks": [BOOKMARK, BOOKMARK]})


def test_bookmarks_saved_and_listed(client: TestClient, settings) -> None:
    report_id = client.post("/api/reports", json={"name": "R"}).json()["id"]
    body = {"name": "R", "pages": [{"id": "p1", "name": "P"}], "bookmarks": [BOOKMARK]}
    saved = client.put(f"/api/reports/{report_id}", json=body)
    assert saved.status_code == 200, saved.text
    assert saved.json()["bookmarks"][0]["pages"]["p1"]["visuals"]["s1"]["selected"] == ["Occitanie"]
    on_disk = json.loads((settings.data_dir / "reports" / f"{report_id}.json").read_text(encoding="utf-8"))
    assert on_disk["bookmarks"][0]["name"] == "Occitanie"
    assert client.get("/api/reports").json()[0]["bookmarks"] == 1


def test_old_report_without_bookmarks_still_loads(client: TestClient, settings) -> None:
    report_id = client.post("/api/reports", json={"name": "Ancien"}).json()["id"]
    path = settings.data_dir / "reports" / f"{report_id}.json"
    raw = json.loads(path.read_text(encoding="utf-8"))
    del raw["bookmarks"]  # rapport écrit avant le jalon 6
    path.write_text(json.dumps(raw), encoding="utf-8")
    got = client.get(f"/api/reports/{report_id}")
    assert got.status_code == 200 and got.json()["bookmarks"] == []
    assert client.get("/api/reports").json()[0]["bookmarks"] == 0
