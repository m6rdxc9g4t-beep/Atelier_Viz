"""Nœud Atelier (docs/SUITE.md §7, `atelier-node/1`) : manifeste, tables d'échange, requêtes, upsert,
idempotence, journal d'événements (émission de chaque type, persistance du seq, gap), erreurs `{detail, code}`.
"""

import asyncio
import json
import re
import sqlite3
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator

from app.core.config import Settings
from app.schemas.atelier import EVENT_TYPES, AtelierTable
from app.schemas.query import QueryRequest
from app.services.atelier.journal import EventJournal
from app.services.atelier.tables import query_key, snake_key, table_frame
from main import create_app

CSV = b"region;CA;date;actif\nNord;100;2026-01-15;oui\nSud;50;2026-02-10;non\nNord;30;2026-02-20;oui\n"
ACTION_ID = re.compile(r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$")
SNAKE = re.compile(r"^[a-z][a-z0-9_]*$")


@pytest.fixture
def node(settings: Settings) -> Iterator[TestClient]:
    """Application dont les enregistrements de rapport sont journalisés immédiatement (sans regroupement)."""
    quick = settings.model_copy(update={"atelier_report_event_seconds": 0.0})
    with TestClient(create_app(quick)) as c:
        yield c


def upload(client: TestClient, content: bytes = CSV, name: str = "ventes.csv") -> dict[str, Any]:
    r = client.post("/api/datasets", files={"file": (name, content, "text/csv")})
    assert r.status_code == 201, r.text
    return r.json()


def events(client: TestClient, **params: Any) -> dict[str, Any]:
    r = client.get("/api/atelier/events", params=params)
    assert r.status_code == 200, r.text
    return r.json()


def of_type(client: TestClient, type_: str) -> list[dict[str, Any]]:
    return [e for e in events(client, limit=500)["events"] if e["type"] == type_]


def table(rows: list[dict[str, Any]] | None = None, **extra: Any) -> dict[str, Any]:
    return {
        "format": "atelier-table/1",
        "name": "work-items",
        "label": "Éléments de travail",
        "columns": [
            {"key": "titre", "label": "Titre", "type": "string"},
            {"key": "heures_estimees", "label": "Heures estimées", "type": "number"},
            {"key": "echeance", "label": "Échéance", "type": "date"},
            {"key": "fait", "label": "Fait", "type": "boolean"},
        ],
        "rows": rows
        if rows is not None
        else [
            {"titre": "Écrire la doc", "heures_estimees": 4, "echeance": "2026-11-02", "fait": False},
            {"titre": "Relire", "heures_estimees": 1.5, "echeance": None, "fait": True},
        ],
        **extra,
    }


# --- Manifeste ----------------------------------------------------------------------------------


def test_manifest_shape(node: TestClient) -> None:
    r = node.get("/api/atelier/manifest")
    assert r.status_code == 200
    m = r.json()
    assert m["contract"] == "atelier-node/1" and m["app"] == "viz" and m["transport"] == "http"
    assert m["name"] == "Atelier Viz" and m["version"]
    ids = [a["id"] for a in m["actions"]]
    assert len(ids) == len(set(ids)) and all(ACTION_ID.match(i) for i in ids)
    assert set(ids) == {
        "datasets.list",
        "datasets.get",
        "datasets.table",
        "datasets.query",
        "datasets.upsert_table",
        "datasets.refresh",
        "reports.list",
        "alerts.list",
    }
    by_id = {a["id"]: a for a in m["actions"]}
    for a in m["actions"]:
        # Exactement un transport, ici toujours HTTP.
        assert (a["http"] is None) != (a["mcp_tool"] is None) and a["http"] is not None
        assert a["kind"] in {"read", "write", "destructive"}
        assert a["idempotency"] in {"header", "field", "natural", "none"}
        assert a["output"]["format"] in {"atelier-table/1", "json"}
        Draft202012Validator.check_schema(a["input_schema"])
        Draft202012Validator.check_schema(a["output"]["schema"])
        assert a["input_schema"]["type"] == "object"
        assert all(SNAKE.match(p) for p in a["input_schema"]["properties"])
        # Paramètres de chemin : toujours des propriétés obligatoires de l'entrée.
        for param in re.findall(r"\{(\w+)\}", a["http"]["path"]):
            assert param in a["input_schema"]["properties"] and param in a["input_schema"]["required"]
    assert (
        by_id["datasets.upsert_table"]["kind"] == "write" and by_id["datasets.upsert_table"]["idempotency"] == "header"
    )
    assert by_id["datasets.refresh"]["kind"] == "write" and by_id["datasets.refresh"]["idempotency"] == "natural"
    assert by_id["datasets.table"]["output"]["format"] == "atelier-table/1"
    assert by_id["datasets.query"]["http"] == {"method": "POST", "path": "/api/atelier/query"}
    assert by_id["datasets.list"]["http"] == {"method": "GET", "path": "/api/datasets"}
    assert {e["type"] for e in m["events"]} == set(EVENT_TYPES)
    for e in m["events"]:
        Draft202012Validator.check_schema(e["data_schema"])
        assert e["data_schema"]["type"] == "object"
    # Aucun secret ni donnée utilisateur : le manifeste ne dépend pas du contenu de l'application.
    upload(node)
    assert node.get("/api/atelier/manifest").json() == m


def test_manifest_actions_answer(node: TestClient) -> None:
    """Chaque action de lecture répond à son chemin, avec une sortie conforme à son schéma."""
    ds = upload(node)
    manifest = node.get("/api/atelier/manifest").json()
    for a in manifest["actions"]:
        if a["kind"] != "read":
            continue
        path = a["http"]["path"].replace("{dataset_id}", ds["id"])
        if a["http"]["method"] == "GET":
            r = node.get(path)
        else:
            r = node.post(path, json={"dataset_id": ds["id"], "measures": [{"field": "CA", "agg": "sum"}]})
        assert r.status_code == 200, (a["id"], r.text)
        Draft202012Validator(a["output"]["schema"]).validate(r.json())


# --- Table d'échange ------------------------------------------------------------------------------


def test_dataset_table_paginated(node: TestClient) -> None:
    ds = upload(node)
    r = node.get(f"/api/atelier/datasets/{ds['id']}/table", params={"limit": 2})
    assert r.status_code == 200
    t = r.json()
    AtelierTable.model_validate(t)
    assert t["format"] == "atelier-table/1" and t["label"] == "ventes.csv" and t["name"] == "ventes_csv"
    assert [c["key"] for c in t["columns"]] == ["region", "ca", "date", "actif"]
    assert [c["label"] for c in t["columns"]] == ["region", "CA", "date", "actif"]
    assert [c["type"] for c in t["columns"]] == ["string", "number", "date", "boolean"]
    assert t["rows"][0] == {"region": "Nord", "ca": 100, "date": "2026-01-15", "actif": True}
    assert t["total"] == 3 and t["truncated"] is True and len(t["rows"]) == 2
    rest = node.get(f"/api/atelier/datasets/{ds['id']}/table", params={"offset": 2, "limit": 2}).json()
    assert len(rest["rows"]) == 1 and rest["rows"][0]["ca"] == 30 and rest["truncated"] is True
    full = node.get(f"/api/atelier/datasets/{ds['id']}/table").json()
    assert len(full["rows"]) == 3 and full["truncated"] is False
    assert node.get(f"/api/atelier/datasets/{ds['id']}/table", params={"limit": 5001}).status_code == 422


def test_dataset_table_datetime_and_calculated(node: TestClient) -> None:
    ds = upload(node, b"Heure de passage;Montant HT\n2026-01-15 10:30;10\n2026-01-16 00:00;20\n", "passages.csv")
    model = {"columns": [{"name": "Montant TTC", "expression": "[Montant HT] * 1.2"}], "measures": []}
    assert node.put(f"/api/datasets/{ds['id']}/model", json=model).status_code == 200
    t = node.get(f"/api/atelier/datasets/{ds['id']}/table").json()
    assert [(c["key"], c["type"]) for c in t["columns"]] == [
        ("heure_de_passage", "datetime"),
        ("montant_ht", "number"),
        ("montant_ttc", "number"),
    ]
    first = t["rows"][0]
    assert datetime.fromisoformat(first["heure_de_passage"]).tzinfo is not None  # horodatage avec fuseau
    assert first["heure_de_passage"].startswith("2026-01-15T10:30:00") and first["montant_ttc"] == 12


def test_snake_keys() -> None:
    assert snake_key("Heures estimées") == "heures_estimees"
    assert snake_key("Échéance (prévue)") == "echeance_prevue"
    assert snake_key("2026") == "colonne_2026"
    assert query_key("sum(CA)") == "sum_ca"
    assert query_key("sum(CA)@ytd") == "sum_ca_ytd"
    assert query_key("avg(prix)@moving_avg3") == "avg_prix_moving_avg3"
    assert query_key("date|month") == "date_month"
    assert query_key("count(*)") == "count"
    assert query_key("count_distinct(magasins.ville)") == "count_distinct_magasins_ville"


def test_query_keys_and_labels(node: TestClient) -> None:
    ds = upload(node)
    body = {
        "dataset_id": ds["id"],
        "dimensions": [{"field": "date", "bin": "month"}],
        "measures": [
            {"field": "CA", "agg": "sum"},
            {"field": "CA", "agg": "sum", "show": {"kind": "ytd", "date": "date"}},
            {"field": None, "agg": "count"},
        ],
    }
    r = node.post("/api/atelier/query", json=body)
    assert r.status_code == 200, r.text
    t = r.json()
    assert [c["key"] for c in t["columns"]] == ["date_month", "sum_ca", "sum_ca_ytd", "count"]
    assert [c["label"] for c in t["columns"]] == [
        "date (Mois)",
        "Somme de CA",
        "Cumul annuel — Somme de CA",
        "Nombre de lignes",
    ]
    assert [c["type"] for c in t["columns"]] == ["date", "number", "number", "number"]
    assert t["rows"] == [
        {"date_month": "2026-01-01", "sum_ca": 100, "sum_ca_ytd": 100, "count": 1},
        {"date_month": "2026-02-01", "sum_ca": 80, "sum_ca_ytd": 180, "count": 2},
    ]
    assert t["truncated"] is False and t["total"] == 2
    # Même moteur que /api/query : mêmes valeurs.
    raw = node.post("/api/query", json=body).json()
    assert [r[1] for r in raw["rows"]] == [row["sum_ca"] for row in t["rows"]]
    # Tronqué : `total` inconnu.
    cut = node.post("/api/atelier/query", json={**body, "limit": 1}).json()
    assert cut["truncated"] is True and cut["total"] is None and len(cut["rows"]) == 1


def test_query_never_accepts_sql(node: TestClient) -> None:
    ds = upload(node)
    bad = {"dataset_id": ds["id"], "measures": [{"field": 'CA"); DROP TABLE x; --', "agg": "sum"}]}
    r = node.post("/api/atelier/query", json=bad)
    assert r.status_code == 422 and r.json()["code"] == "VALIDATION" and "inconnu" in r.json()["detail"]
    assert "sql" not in QueryRequest.model_json_schema()["properties"]


# --- Upsert --------------------------------------------------------------------------------------


def test_upsert_creates_then_updates(node: TestClient) -> None:
    body = {"name": "Éléments Projets", "key": "nexus:hebdo", "table": table()}
    r = node.post("/api/atelier/datasets", json=body)
    assert r.status_code == 201, r.text
    created = r.json()
    assert created["action"] == "created" and created["rows"] == 2 and created["name"] == "Éléments Projets"
    profile = node.get(f"/api/datasets/{created['dataset_id']}").json()
    assert profile["format"] == "atelier_table"
    assert profile["origin"]["kind"] == "atelier-table" and profile["origin"]["key"] == "nexus:hebdo"
    assert [(c["name"], c["type"]) for c in profile["columns"]] == [
        ("Titre", "string"),
        ("Heures estimées", "number"),
        ("Échéance", "date"),
        ("Fait", "boolean"),
    ]
    ds_id = created["dataset_id"]
    # Un modèle sur le jeu : il est revalidé et conservé à la mise à jour.
    model = {"columns": [], "measures": [{"name": "Charge", "expression": "SUM([Heures estimées])"}]}
    assert node.put(f"/api/datasets/{ds_id}/model", json=model).status_code == 200

    rows = [{"titre": f"T{i}", "heures_estimees": i, "echeance": "2026-12-01", "fait": False} for i in range(5)]
    r = node.post("/api/atelier/datasets", json={"name": "Autre nom", "key": "nexus:hebdo", "table": table(rows)})
    assert r.status_code == 200 and r.json() == {
        "dataset_id": ds_id,
        "name": "Éléments Projets",
        "rows": 5,
        "action": "updated",
    }
    assert len(node.get("/api/datasets").json()) == 1
    q = node.post("/api/query", json={"dataset_id": ds_id, "measures": [{"field": "Charge", "agg": "calc"}]})
    assert q.json()["rows"] == [[10]]

    # Modèle qui ne tient plus (colonne disparue) : 409, rien n'a changé.
    shrunk = table([{"titre": "x"}])
    shrunk["columns"] = [shrunk["columns"][0]]
    r = node.post("/api/atelier/datasets", json={"name": "x", "key": "nexus:hebdo", "table": shrunk})
    assert r.status_code == 409 and r.json()["code"] == "CONFLICT" and r.json()["issues"]
    assert node.get(f"/api/datasets/{ds_id}").json()["rows"] == 5

    # Un jeu alimenté par un workflow ne s'actualise pas comme une connexion.
    r = node.post(f"/api/datasets/{ds_id}/refresh")
    assert r.status_code == 422 and "workflow" in r.json()["detail"]
    assert node.get("/api/refresh").json() == []
    assert ds_id in node.get("/api/refresh/versions").json()


def test_upsert_validation(node: TestClient) -> None:
    def post(body: dict[str, Any]) -> Any:
        return node.post("/api/atelier/datasets", json=body)

    bad_key = post({"name": "a", "key": "Majuscules interdites", "table": table()})
    assert bad_key.status_code == 422 and bad_key.json()["code"] == "VALIDATION" and "key" in bad_key.json()["detail"]
    dup = table()
    dup["columns"].append({"key": "titre", "label": "Autre", "type": "string"})
    assert post({"name": "a", "key": "k", "table": dup}).json()["code"] == "VALIDATION"
    stray = table([{"titre": "x", "inconnue": 1}])
    r = post({"name": "a", "key": "k", "table": stray})
    assert r.status_code == 422 and "inconnue" in r.json()["detail"]
    too_wide = table([])
    too_wide["columns"] = [{"key": f"c{i}", "label": f"C{i}", "type": "number"} for i in range(201)]
    assert post({"name": "a", "key": "k", "table": too_wide}).status_code == 422
    assert post({"name": "a", "key": "k", "table": {**table(), "format": "atelier-table/2"}}).status_code == 422
    assert node.get("/api/datasets").json() == []


def test_table_frame_types() -> None:
    t = AtelierTable.model_validate(
        table(
            [
                {"titre": 12, "heures_estimees": "3,5", "echeance": "2026-11-02", "fait": "oui"},
                {"titre": None, "heures_estimees": True, "echeance": "pas une date", "fait": None},
            ]
        )
    )
    df = table_frame(t)
    assert list(df.columns) == ["Titre", "Heures estimées", "Échéance", "Fait"]
    assert df["Titre"].tolist()[0] == "12" and df["Heures estimées"].tolist()[0] == 3.5
    assert df["Heures estimées"].isna().tolist()[1] and df["Échéance"].isna().tolist()[1]
    assert str(df["Échéance"].dtype).startswith("datetime64") and bool(df["Fait"].tolist()[0]) is True


# --- Idempotence -----------------------------------------------------------------------------------


def test_upsert_idempotency(node: TestClient, settings: Settings) -> None:
    body = {"name": "Hebdo", "key": "nexus:run-1", "table": table()}
    headers = {"Idempotency-Key": "nexus:run-42:step-3"}
    first = node.post("/api/atelier/datasets", json=body, headers=headers)
    assert first.status_code == 201 and "idempotency-replayed" not in first.headers
    before = events(node)["next"]
    # Même clé, même corps (ordre des clés différent) : même réponse, rejouée, rien de refait.
    reordered = {"table": body["table"], "key": body["key"], "name": body["name"]}
    again = node.post("/api/atelier/datasets", json=reordered, headers=headers)
    assert again.status_code == 201 and again.json() == first.json()
    assert again.headers["Idempotency-Replayed"] == "true"
    assert len(node.get("/api/datasets").json()) == 1 and events(node)["next"] == before
    # Même clé, autre corps : 409.
    other = node.post("/api/atelier/datasets", json={**body, "name": "Autre"}, headers=headers)
    assert other.status_code == 409 and other.json()["code"] == "IDEMPOTENCY_KEY_REUSED"
    # Nouvelle clé : nouvelle exécution (mise à jour du même jeu, clé externe identique).
    third = node.post("/api/atelier/datasets", json=body, headers={"Idempotency-Key": "nexus:run-43:step-3"})
    assert third.status_code == 200 and third.json()["action"] == "updated"
    assert node.post("/api/atelier/datasets", json=body, headers={"Idempotency-Key": "x" * 201}).status_code == 422
    # Persistant : survit au redémarrage.
    stored = json.loads((settings.data_dir / "atelier_idempotency.json").read_text(encoding="utf-8"))
    assert len(stored["entries"]) == 2


def test_idempotency_survives_restart_and_expires(settings: Settings) -> None:
    from app.services.atelier.idempotency import IdempotencyStore, fingerprint

    quick = settings.model_copy(update={"atelier_report_event_seconds": 0.0})
    body = {"name": "Hebdo", "key": "k1", "table": table()}
    headers = {"Idempotency-Key": "cle-1"}
    with TestClient(create_app(quick)) as c:
        assert c.post("/api/atelier/datasets", json=body, headers=headers).status_code == 201
    with TestClient(create_app(quick)) as c:
        r = c.post("/api/atelier/datasets", json=body, headers=headers)
        assert r.status_code == 201 and r.headers["Idempotency-Replayed"] == "true"
    now = [datetime(2026, 1, 1, tzinfo=UTC)]
    store = IdempotencyStore(settings.data_dir / "expire.json", clock=lambda: now[0])
    store.save("s", "k", fingerprint({"a": 1}), 201, {"ok": True})
    assert store.lookup("s", "k") is not None
    now[0] += timedelta(days=31)
    assert store.lookup("s", "k") is None


# --- Journal d'événements --------------------------------------------------------------------------


def test_events_emitted_for_datasets_and_reports(node: TestClient, tmp_path: Path) -> None:
    ds = upload(node)
    created = of_type(node, "viz.dataset.created")
    assert created[-1]["subject"] == {"kind": "dataset", "id": ds["id"], "label": "ventes.csv"}
    assert created[-1]["data"] == {"name": "ventes.csv", "rows": 3, "origin": "file", "format": "csv"}
    # Aucune ligne de données dans le journal.
    assert "Nord" not in json.dumps(events(node))

    report = node.post("/api/reports", json={"name": "Suivi", "dataset_id": ds["id"]}).json()
    saved = of_type(node, "viz.report.saved")
    assert saved[-1]["subject"] == {"kind": "report", "id": report["id"], "label": "Suivi"}
    assert saved[-1]["data"] == {"pages": 1}
    body = {k: report[k] for k in ("name", "dataset_id", "pages", "theme")}
    body["pages"] = [*body["pages"], {**body["pages"][0], "id": "p2", "name": "Page 2"}]
    assert node.put(f"/api/reports/{report['id']}", json=body).status_code == 200
    assert of_type(node, "viz.report.saved")[-1]["data"] == {"pages": 2}

    assert node.delete(f"/api/datasets/{ds['id']}").status_code == 204
    deleted = of_type(node, "viz.dataset.deleted")
    assert deleted[-1]["subject"]["id"] == ds["id"] and deleted[-1]["data"] == {}

    up = node.post("/api/atelier/datasets", json={"name": "Hebdo", "key": "nexus:k", "table": table()}).json()
    created = of_type(node, "viz.dataset.created")[-1]
    assert created["data"] == {
        "name": "Hebdo",
        "rows": 2,
        "origin": "atelier-table",
        "format": "atelier_table",
        "key": "nexus:k",
    }
    node.post("/api/atelier/datasets", json={"name": "Hebdo", "key": "nexus:k", "table": table([])})
    refreshed = of_type(node, "viz.dataset.refreshed")[-1]
    assert refreshed["subject"]["id"] == up["dataset_id"]
    assert refreshed["data"] == {"rows": 0, "trigger": "manual", "source": "atelier-table"}

    # Exemples : un événement par jeu créé.
    samples = node.post("/api/samples").json()
    names = {e["data"]["name"] for e in of_type(node, "viz.dataset.created")}
    assert set(samples["imported"]) <= names

    seqs = [e["seq"] for e in events(node, limit=500)["events"]]
    assert seqs == sorted(seqs) and len(seqs) == len(set(seqs))
    for e in events(node, limit=500)["events"]:
        datetime.fromisoformat(e["at"])  # ISO 8601 avec fuseau
        assert e["at"][-6] in "+-" and e["type"] in EVENT_TYPES
        assert e["subject"]["kind"] == EVENT_TYPES[e["type"]][1]
        Draft202012Validator(EVENT_TYPES[e["type"]][2].model_json_schema()).validate(e["data"])


def test_report_events_are_coalesced(settings: Settings) -> None:
    """Enregistrement automatique du Studio : une rafale = un événement, émis à la fin (ou à l'arrêt)."""
    with TestClient(create_app(settings)) as c:  # regroupement par défaut (5 s)
        report = c.post("/api/reports", json={"name": "R"}).json()
        body = {k: report[k] for k in ("name", "dataset_id", "pages", "theme")}
        for _ in range(5):
            c.put(f"/api/reports/{report['id']}", json=body)
        assert of_type(c, "viz.report.saved") == []
    with TestClient(create_app(settings)) as c:
        assert len(of_type(c, "viz.report.saved")) == 1


@pytest.fixture
def sqlite_source(tmp_path: Path) -> Path:
    path = tmp_path / "source.db"
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE ventes (region TEXT, ca REAL)")
    con.executemany("INSERT INTO ventes VALUES (?, ?)", [("Nord", 10.0), ("Sud", 5.0)])
    con.commit()
    con.close()
    return path


def test_events_for_connection_refresh_and_alerts(node: TestClient, sqlite_source: Path) -> None:
    conn = node.post("/api/connections", json={"name": "Base", "kind": "sqlite", "path": str(sqlite_source)}).json()
    ds = node.post(f"/api/connections/{conn['id']}/import", json={"table": {"name": "ventes"}}).json()
    created = of_type(node, "viz.dataset.created")[-1]
    assert created["data"] == {"name": "ventes", "rows": 2, "origin": "sqlite", "format": "sqlite"}
    assert str(sqlite_source) not in json.dumps(created)  # aucun chemin ni détail de connexion

    alert = {
        "name": "CA élevé",
        "dataset_id": ds["id"],
        "measure": {"field": "ca", "agg": "sum"},
        "comparison": "gt",
        "threshold": 20,
        "system": False,
    }
    assert node.post("/api/alerts", json=alert).status_code == 201  # 15 : pas de franchissement
    assert of_type(node, "viz.alert.triggered") == []

    con = sqlite3.connect(sqlite_source)
    con.execute("INSERT INTO ventes VALUES ('Est', 30.0)")
    con.commit()
    con.close()
    assert node.post(f"/api/datasets/{ds['id']}/refresh").status_code == 200
    refreshed = of_type(node, "viz.dataset.refreshed")[-1]
    assert refreshed["subject"]["id"] == ds["id"]
    assert refreshed["data"] == {"rows": 3, "trigger": "manual", "source": "connection"}
    fired = of_type(node, "viz.alert.triggered")
    assert len(fired) == 1 and fired[0]["subject"]["kind"] == "alert" and fired[0]["subject"]["label"] == "CA élevé"
    assert fired[0]["data"] == {
        "dataset_id": ds["id"],
        "value": 45,
        "comparison": "gt",
        "threshold": 20,
        "basis": "value",
    }
    assert fired[0]["seq"] > refreshed["seq"]
    # Toujours au-dessus du seuil : pas de nouveau déclenchement (anti-rebond).
    node.post(f"/api/refresh/{ds['id']}/run")
    assert len(of_type(node, "viz.alert.triggered")) == 1

    # Échec : source disparue.
    sqlite_source.unlink()
    assert node.post(f"/api/refresh/{ds['id']}/run").json()["status"] == "error"
    failed = of_type(node, "viz.dataset.refresh_failed")[-1]
    assert failed["subject"]["id"] == ds["id"] and failed["data"]["trigger"] == "manual"
    assert failed["data"]["status"] == "error" and failed["data"]["message"]


def test_alert_for_each_event(node: TestClient) -> None:
    ds = upload(node)
    alert = {
        "name": "Région forte",
        "dataset_id": ds["id"],
        "measure": {"field": "CA", "agg": "sum"},
        "comparison": "gt",
        "threshold": 60,
        "split_by": "region",
        "system": False,
    }
    assert node.post("/api/alerts", json=alert).status_code == 201
    fired = of_type(node, "viz.alert.triggered")
    assert len(fired) == 1
    assert fired[0]["data"]["dimension"] == "region"
    assert fired[0]["data"]["values"] == [{"key": "Nord", "value": 130}]


def test_scheduled_refresh_events(node: TestClient, sqlite_source: Path) -> None:
    conn = node.post("/api/connections", json={"name": "Base", "kind": "sqlite", "path": str(sqlite_source)}).json()
    ds = node.post(f"/api/connections/{conn['id']}/import", json={"table": {"name": "ventes"}}).json()
    scheduler = node.app.state.scheduler  # type: ignore[attr-defined]
    asyncio.run(scheduler.run(ds["id"], "schedule"))
    assert of_type(node, "viz.dataset.refreshed")[-1]["data"]["trigger"] == "schedule"


def test_events_paging_and_filters(node: TestClient) -> None:
    empty = events(node)
    assert empty == {"events": [], "next": 0, "oldest": 1, "gap": False}
    for i in range(5):
        upload(node, name=f"j{i}.csv")
    assert [e["seq"] for e in events(node)["events"]] == [1, 2, 3, 4, 5]
    page = events(node, since=1, limit=2)
    assert [e["seq"] for e in page["events"]] == [2, 3] and page["next"] == 3 and page["oldest"] == 1
    assert events(node, since=5) == {"events": [], "next": 5, "oldest": 1, "gap": False}
    latest = events(node, limit=2)
    assert [e["seq"] for e in latest["events"]] == [4, 5] and latest["next"] == 5
    node.post("/api/reports", json={"name": "R"})
    only = events(node, types="viz.report.saved,viz.alert.triggered")
    assert [e["type"] for e in only["events"]] == ["viz.report.saved"]
    assert node.get("/api/atelier/events", params={"limit": 501}).json()["code"] == "VALIDATION"


def test_seq_persists_after_restart(settings: Settings) -> None:
    quick = settings.model_copy(update={"atelier_report_event_seconds": 0.0})
    with TestClient(create_app(quick)) as c:
        upload(c)
        upload(c, name="b.csv")
        last = events(c)["next"]
    assert last == 2
    with TestClient(create_app(quick)) as c:
        assert events(c, since=0)["next"] == 2
        upload(c, name="c.csv")
        assert [e["seq"] for e in events(c, since=2)["events"]] == [3]
    # Journal effacé à la main : le seq ne repart jamais en arrière (fichier .seq), et le consommateur le voit.
    (settings.data_dir / "atelier_events.jsonl").unlink()
    with TestClient(create_app(quick)) as c:
        upload(c, name="d.csv")
        page = events(c, since=3)
        assert [e["seq"] for e in page["events"]] == [4]
        assert events(c, since=1)["gap"] is True


def test_journal_retention_and_gap(tmp_path: Path) -> None:
    now = [datetime(2026, 1, 1, tzinfo=UTC)]
    journal = EventJournal(tmp_path / "ev.jsonl", clock=lambda: now[0], keep=10, max_age=timedelta(days=30))
    for i in range(30):
        journal.emit("viz.report.saved", f"r{i}", None, {"pages": 1})
    # Récents (< 30 jours) : tous gardés.
    assert journal.page(0, 500).oldest == 1
    now[0] += timedelta(days=40)
    for i in range(30):
        journal.emit("viz.report.saved", f"s{i}", None, {"pages": 1})
    page = journal.page(0, 500)
    assert page.oldest > 1 and page.gap is True
    assert len(page.events) >= 10 and page.events[-1].seq == 60
    assert journal.page(page.oldest - 1, 500).gap is False
    # Rechargé depuis le disque : même état (fichier réécrit atomiquement).
    again = EventJournal(tmp_path / "ev.jsonl", clock=lambda: now[0], keep=10)
    assert again.last_seq == 60 and again.page(None, 500).oldest == page.oldest
    # Une ligne tronquée (coupure) est ignorée.
    with (tmp_path / "ev.jsonl").open("a", encoding="utf-8") as fh:
        fh.write('{"seq": 61, "type": "viz.rep')
    assert EventJournal(tmp_path / "ev.jsonl").last_seq == 60
    with pytest.raises(ValueError):
        journal.emit("viz.inconnu", "x", None, {})


# --- Erreurs et garde locale ----------------------------------------------------------------------


def test_errors_follow_contract(node: TestClient) -> None:
    r = node.get("/api/atelier/datasets/aaaaaaaaaaaa/table")
    assert r.status_code == 404 and r.json() == {
        "detail": "Jeu de données « aaaaaaaaaaaa » introuvable.",
        "code": "NOT_FOUND",
    }
    assert node.get("/api/atelier/inconnu").json()["code"] == "NOT_FOUND"
    assert node.post("/api/atelier/query", json={"dataset_id": "x"}).json()["code"] == "VALIDATION"
    # Les autres routes gardent leur forme.
    assert "code" not in node.get("/api/datasets/aaaaaaaaaaaa").json()
    assert isinstance(node.post("/api/query", json={}).json()["detail"], list)


def test_local_only_guard_applies(settings: Settings) -> None:
    local = settings.model_copy(update={"allowed_hosts": []})
    with TestClient(create_app(local), base_url="http://127.0.0.1:8000") as c:
        assert c.get("/api/atelier/manifest").status_code == 200
        assert c.get("/api/atelier/manifest", headers={"Host": "evil.example"}).status_code == 403
        body = {"name": "a", "key": "k", "table": table()}
        r = c.post("/api/atelier/datasets", json=body, headers={"Origin": "https://evil.example"})
        assert r.status_code == 403
        assert c.get("/api/datasets").json() == []
