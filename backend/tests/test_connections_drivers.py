"""Connecteurs essayés avec leurs **vrais pilotes** (requirements-connectors.txt), sans vrai serveur.

Chaque test est ignoré quand son pilote n'est pas installé (c'est le cas de l'intégration continue, qui n'installe
que requirements-dev.txt). Avec les pilotes :
- SQL Server, PostgreSQL, MySQL : le vrai pilote reçoit nos arguments et échoue sur un port fermé de cette
  machine — l'erreur est celle du réseau, dite en français, jamais un argument refusé par le pilote ;
- SQL Server et Snowflake : parcours complet (test, tables, aperçu, import, actualisation, requête libre) sur un
  moteur simulé branché à la place de `connect` du vrai module, après contrôle des arguments par le vrai pilote.
SQLite, lui, est essayé pour de vrai dans test_connections.py.
"""

import inspect
import re
import socket
import sqlite3
import warnings
from typing import Any

import pytest
from fastapi.testclient import TestClient

ROWS = [("Nord", 10.0), ("Sud", 5.0), ("Est", 7.5)]


def closed_port() -> int:
    """Port de bouclage où rien n'écoute (ouvert puis refermé)."""
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def make(client: TestClient, **fields: Any) -> dict[str, Any]:
    r = client.post("/api/connections", json=fields)
    assert r.status_code == 201, r.text
    return r.json()


class Engine:
    """Moteur simulé : une base SQLite en mémoire derrière l'interface DB-API, qui comprend le SQL du dialecte."""

    def __init__(self, schema: str, version: str) -> None:
        self.db = sqlite3.connect(":memory:", check_same_thread=False)
        self.db.execute(f"ATTACH ':memory:' AS {schema}")
        self.db.execute(f"CREATE TABLE {schema}.ventes (region TEXT, ca REAL)")
        self.db.executemany(f"INSERT INTO {schema}.ventes VALUES (?, ?)", ROWS)
        self.db.execute("ATTACH ':memory:' AS INFORMATION_SCHEMA")
        self.db.execute("CREATE TABLE INFORMATION_SCHEMA.TABLES (TABLE_SCHEMA TEXT, TABLE_NAME TEXT, TABLE_TYPE TEXT)")
        self.db.execute("INSERT INTO INFORMATION_SCHEMA.TABLES VALUES (?, 'ventes', 'BASE TABLE')", [schema])
        self.version = version
        self.seen: list[str] = []
        self.closed = False

    def cursor(self) -> "Cursor":
        return Cursor(self)

    def close(self) -> None:
        self.closed = True


class Cursor:
    def __init__(self, engine: Engine) -> None:
        self.engine = engine
        self.cur = engine.db.cursor()

    def execute(self, sql: str, params: Any = None) -> None:
        self.engine.seen.append(sql)
        # T-SQL → SQLite : « TOP (n) » devient « LIMIT n », la version du serveur une constante.
        top = re.match(r"SELECT TOP \((\d+)\) (.*)", sql, re.S)
        if top:
            sql = f"SELECT {top.group(2)} LIMIT {top.group(1)}"
        sql = sql.replace("@@VERSION", f"'{self.engine.version}'")
        sql = sql.replace("'Snowflake ' || CURRENT_VERSION()", f"'{self.engine.version}'")
        self.cur.execute(sql, params or [])

    @property
    def description(self) -> Any:
        return self.cur.description

    def fetchmany(self, size: int) -> list[Any]:
        return self.cur.fetchmany(size)

    def close(self) -> None:
        self.cur.close()


def journey(client: TestClient, cid: str, schema: str, engine: Engine) -> None:
    """Test, tables, aperçu, import d'une table, actualisation, requête libre, écriture refusée."""
    test = client.post(f"/api/connections/{cid}/test").json()
    assert test == {"ok": True, "message": "Connexion réussie.", "server": engine.version}, test
    tables = client.get(f"/api/connections/{cid}/tables").json()["tables"]
    assert [(t["schema"], t["name"], t["kind"]) for t in tables] == [(schema, "ventes", "table")]

    ref = {"schema": schema, "name": "ventes"}
    preview = client.post(f"/api/connections/{cid}/preview", json={"table": ref, "limit": 2}).json()
    assert preview["truncated"] is True and preview["rows"] == [
        {"region": "Nord", "ca": 10.0},
        {"region": "Sud", "ca": 5.0},
    ]

    created = client.post(f"/api/connections/{cid}/import", json={"table": ref})
    assert created.status_code == 201, created.text
    ds = created.json()
    assert ds["rows"] == 3 and {c["name"]: c["type"] for c in ds["columns"]} == {"region": "string", "ca": "number"}

    engine.db.execute(f"INSERT INTO {schema}.ventes VALUES ('Ouest', 2.5)")
    refreshed = client.post(f"/api/datasets/{ds['id']}/refresh")
    assert refreshed.status_code == 200, refreshed.text
    assert refreshed.json()["rows"] == 4

    query = f"SELECT region, SUM(ca) AS total FROM {schema}.ventes GROUP BY region ORDER BY total DESC"
    top = client.post(f"/api/connections/{cid}/preview", json={"query": query}).json()
    assert top["rows"][0] == {"region": "Nord", "total": 10.0}
    refused = client.post(f"/api/connections/{cid}/preview", json={"query": f"DELETE FROM {schema}.ventes"})
    assert refused.status_code == 422 and not any(s.startswith("DELETE") for s in engine.seen)
    assert engine.closed is True


@pytest.mark.parametrize(
    ("kind", "module", "label"),
    [
        ("sqlserver", "pymssql", "SQL Server"),
        ("postgres", "psycopg", "PostgreSQL"),
        ("mysql", "pymysql", "MySQL / MariaDB"),
    ],
)
def test_real_driver_takes_our_arguments_and_fails_on_the_network_only(
    client: TestClient, kind: str, module: str, label: str
) -> None:
    pytest.importorskip(module)
    infos = {c["kind"]: c for c in client.get("/api/connections/connectors").json()}
    assert infos[kind]["driver_installed"] is True and infos[kind]["install_hint"] is None
    body = {"name": label, "kind": kind, "host": "127.0.0.1", "port": closed_port(), "database": "ventes"}
    for extra in ({}, {"username": "lecteur", "password": "secret"}, {"encrypt": True} if kind == "sqlserver" else {}):
        res = client.post("/api/connections/test", json=body | extra).json()
        assert res["ok"] is False and res["server"] is None
        # « Connexion impossible » = le pilote a accepté l'appel et n'a trouvé personne ; un argument inconnu
        # donnerait « unexpected keyword argument », un pilote absent « Pilote … absent ».
        assert res["message"].startswith(f"Connexion impossible à {label} : "), res
        assert "argument" not in res["message"] and "Pilote" not in res["message"]
        assert "secret" not in res["message"]


def test_sqlserver_end_to_end_on_a_simulated_engine(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    pymssql = pytest.importorskip("pymssql")
    signature = inspect.signature(pymssql.connect)  # le vrai pilote dit quels arguments il accepte
    engine = Engine("dbo", "Microsoft SQL Server 2022 (RTM) - 16.0 (simulé)")
    calls: list[dict[str, Any]] = []

    def connect(**kwargs: Any) -> Engine:
        signature.bind(**kwargs)
        calls.append(kwargs)
        return engine

    monkeypatch.setattr(pymssql, "connect", connect)
    c = make(
        client,
        name="Ventes",
        kind="sqlserver",
        host="127.0.0.1",
        port=1433,
        database="Ventes",
        username="lecteur",
        password="s3cret",
        encrypt=True,
    )
    journey(client, c["id"], "dbo", engine)
    call = calls[0]
    assert call["server"] == "127.0.0.1" and call["port"] == "1433" and call["database"] == "Ventes"
    assert call["user"] == "lecteur" and call["password"] == "s3cret"
    assert call["read_only"] is True and call["encryption"] == "require" and call["appname"] == "Atelier Viz"
    assert "SELECT TOP (3) * FROM [dbo].[ventes]" in engine.seen  # aperçu : 2 lignes + 1 pour « il y en a plus »


def test_snowflake_end_to_end_on_a_simulated_engine(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    connector = pytest.importorskip("snowflake.connector")
    engine = Engine("PUBLIC", "Snowflake 9.12.1 (simulé)")
    calls: list[dict[str, Any]] = []

    def connect(**kwargs: Any) -> Engine:
        config = getattr(connector, "ConnectionConfig", None)
        if config is not None and hasattr(config, "from_kwargs"):
            # Pilote 5.x : il lit lui-même nos arguments (« network_timeout » y est un alias hérité, encore accepté).
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", DeprecationWarning)
                parsed = config.from_kwargs(**kwargs)
            assert parsed.account == "monorg-moncompte" and parsed.warehouse == "WH_XS" and parsed.role == "LECTEUR"
            assert not getattr(parsed, "_extra", None), "argument inconnu du pilote Snowflake"
        calls.append(kwargs)
        return engine

    monkeypatch.setattr(connector, "connect", connect)
    c = make(
        client,
        name="Entrepôt",
        kind="snowflake",
        host="monorg-moncompte",
        database="VENTES",
        username="viz",
        password="s3cret",
        warehouse="WH_XS",
        role="LECTEUR",
    )
    offline = client.post(f"/api/connections/{c['id']}/test")
    assert offline.status_code == 403 and calls == []  # hors ligne : le pilote n'est même pas appelé
    client.put("/api/settings", json={"online_mode": True})
    journey(client, c["id"], "PUBLIC", engine)
    assert calls[0]["session_parameters"]["QUERY_TAG"] == "Atelier Viz" and calls[0]["password"] == "s3cret"
