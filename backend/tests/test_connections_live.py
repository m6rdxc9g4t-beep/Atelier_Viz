"""Essais sur de vrais serveurs PostgreSQL / MySQL (ignorés par défaut).

Lancer avec, par exemple :
    ATELIER_TEST_PG="127.0.0.1:5433/ventes/atelier/secret" \\
    ATELIER_TEST_MYSQL="127.0.0.1:3307/boutique/atelier/secret" pytest tests/test_connections_live.py
Format : hôte:port/base/utilisateur/mot_de_passe.
"""

import os
from typing import Any

import pytest
from fastapi.testclient import TestClient


def target(var: str) -> dict[str, Any]:
    raw = os.environ.get(var)
    if not raw:
        pytest.skip(f"{var} non défini")
    hostport, database, user, password = raw.split("/", 3)
    host, port = hostport.rsplit(":", 1)
    return {"host": host, "port": int(port), "database": database, "username": user, "password": password}


@pytest.mark.parametrize("kind", ["postgres", "mysql"])
def test_live_server(client: TestClient, kind: str) -> None:
    cfg = target("ATELIER_TEST_PG" if kind == "postgres" else "ATELIER_TEST_MYSQL")
    test = client.post("/api/connections/test", json={"name": kind, "kind": kind, **cfg}).json()
    assert test["ok"] is True, test
    c = client.post("/api/connections", json={"name": kind, "kind": kind, **cfg}).json()
    tables = client.get(f"/api/connections/{c['id']}/tables").json()["tables"]
    assert tables
    first = tables[0]
    preview = client.post(f"/api/connections/{c['id']}/preview", json={"table": first, "limit": 3}).json()
    assert preview["columns"]
    ds = client.post(f"/api/connections/{c['id']}/import", json={"table": first})
    assert ds.status_code == 201, ds.text
    assert client.post(f"/api/datasets/{ds.json()['id']}/refresh").status_code == 200
    # La session est en lecture seule côté serveur, même si le filtre laissait passer une écriture.
    from app.schemas.connection import ConnectionFields
    from app.services.connectors import sql

    fields = ConnectionFields(name=kind, kind=kind, **{k: v for k, v in cfg.items() if k != "password"})
    with sql.connect(fields, cfg["password"], 10, 10) as conn:
        cur = conn.cursor()
        with pytest.raises(Exception):  # noqa: B017 — chaque pilote a sa propre exception
            cur.execute("CREATE TABLE interdit (a int)")
