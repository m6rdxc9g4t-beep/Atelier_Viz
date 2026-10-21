"""Pages d'extraction : champs enregistrés avec la page, validés."""


def test_drillthrough_page_roundtrip(client) -> None:
    created = client.post("/api/reports", json={"name": "Extraction"}).json()
    pages = [
        {"id": "p1", "name": "Synthèse", "visuals": [], "filters": []},
        {"id": "p2", "name": "Détail région", "visuals": [], "filters": [], "drillthrough": {"fields": ["region"]}},
    ]
    body = {"name": "Extraction", "dataset_id": None, "theme": {}, "pages": pages}
    assert client.put(f"/api/reports/{created['id']}", json=body).status_code == 200
    saved = client.get(f"/api/reports/{created['id']}").json()["pages"]
    assert saved[0]["drillthrough"] is None
    assert saved[1]["drillthrough"] == {"fields": ["region"]}
    bad = {**body, "pages": [{**pages[1], "drillthrough": {"fields": []}}]}
    assert client.put(f"/api/reports/{created['id']}", json=bad).status_code == 422
