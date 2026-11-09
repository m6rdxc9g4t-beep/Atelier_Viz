"""Connecteurs Snowflake et BigQuery, pilotes simulés (aucun réseau, aucun paquet requis) :
mode en ligne obligatoire, paramètres de session, lecture par DB-API, liste des tables, plafond BigQuery.
"""

import json
import sqlite3
import sys
import types
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.services.connectors.sql import DIALECTS


def _sqlite() -> sqlite3.Connection:
    con = sqlite3.connect(":memory:", check_same_thread=False)
    con.execute("CREATE TABLE ventes (region TEXT, ca REAL)")
    con.executemany("INSERT INTO ventes VALUES (?, ?)", [("Nord", 10.0), ("Sud", 5.0)])
    return con


class FakeSnowflake(types.ModuleType):
    def __init__(self) -> None:
        super().__init__("snowflake.connector")
        self.calls: list[dict[str, Any]] = []

    def connect(self, **kwargs: Any) -> sqlite3.Connection:
        self.calls.append(kwargs)
        con = _sqlite()
        con.execute("CREATE TABLE TABLES (TABLE_SCHEMA TEXT, TABLE_NAME TEXT, TABLE_TYPE TEXT)")
        con.execute("INSERT INTO TABLES VALUES ('PUBLIC', 'ventes', 'BASE TABLE')")
        con.execute("ATTACH ':memory:' AS INFORMATION_SCHEMA")
        con.execute("CREATE TABLE INFORMATION_SCHEMA.TABLES AS SELECT * FROM main.TABLES")
        con.create_function("CURRENT_VERSION", 0, lambda: "8.40.1")
        return con


@pytest.fixture
def snowflake(monkeypatch: pytest.MonkeyPatch) -> Iterator[FakeSnowflake]:
    fake = FakeSnowflake()
    parent = types.ModuleType("snowflake")
    parent.connector = fake  # type: ignore[attr-defined]
    parent.__path__ = []  # type: ignore[attr-defined]
    fake.__spec__ = types.SimpleNamespace(name="snowflake.connector")  # type: ignore[assignment]
    monkeypatch.setitem(sys.modules, "snowflake", parent)
    monkeypatch.setitem(sys.modules, "snowflake.connector", fake)
    monkeypatch.setattr(type(DIALECTS["snowflake"]), "driver_installed", lambda self: True)
    yield fake


def make(client: TestClient, **fields: Any) -> dict[str, Any]:
    r = client.post("/api/connections", json=fields)
    assert r.status_code == 201, r.text
    return r.json()


def test_snowflake_online_only_session_and_import(client: TestClient, snowflake: FakeSnowflake) -> None:
    c = make(
        client,
        name="Entrepôt",
        kind="snowflake",
        host="monorg-moncompte",
        database="VENTES",
        username="viz",
        password="p",
        warehouse="WH_XS",
        role="LECTEUR",
    )
    offline = client.post(f"/api/connections/{c['id']}/test")
    assert offline.status_code == 403 and "hors ligne" in offline.json()["detail"].lower()
    assert snowflake.calls == []

    client.put("/api/settings", json={"online_mode": True})
    res = client.post(f"/api/connections/{c['id']}/test").json()
    assert res["ok"] is True and "Snowflake 8.40.1" in res["server"]
    call = snowflake.calls[-1]
    assert call["account"] == "monorg-moncompte" and call["warehouse"] == "WH_XS" and call["role"] == "LECTEUR"
    assert call["password"] == "p" and call["session_parameters"]["QUERY_TAG"] == "Atelier Viz"

    tables = client.get(f"/api/connections/{c['id']}/tables").json()["tables"]
    assert {"schema": "PUBLIC", "name": "ventes", "kind": "table"}.items() <= tables[0].items()
    ds = client.post(f"/api/connections/{c['id']}/import", json={"query": "SELECT region, ca FROM ventes"}).json()
    assert ds["rows"] == 2
    refused = client.post(f"/api/connections/{c['id']}/preview", json={"query": "DELETE FROM ventes"})
    assert refused.status_code == 422


def test_snowflake_account_validation(client: TestClient) -> None:
    assert client.post("/api/connections", json={"name": "S", "kind": "snowflake"}).status_code == 422
    assert client.post("/api/connections", json={"name": "S", "kind": "snowflake", "host": "a b"}).status_code == 422


def _fake_bigquery(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    seen: dict[str, Any] = {}

    class QueryJobConfig:
        def __init__(self, **kw: Any) -> None:
            seen["job_config"] = kw

    class Client:
        def __init__(self, project: str, credentials: Any, default_query_job_config: Any) -> None:
            seen["project"] = project
            seen["credentials"] = credentials

        def list_datasets(self, project: str) -> list[Any]:
            return [types.SimpleNamespace(dataset_id="commerce", reference="commerce")]

        def list_tables(self, ref: str) -> list[Any]:
            return [
                types.SimpleNamespace(table_id="ventes", table_type="TABLE"),
                types.SimpleNamespace(table_id="v_mois", table_type="VIEW"),
            ]

    def dbapi_connect(client: Any) -> Any:
        con = _sqlite()

        class Conn:
            def cursor(self) -> Any:
                return con.cursor()

            def close(self) -> None:
                con.close()

        return Conn()

    def from_info(info: dict[str, Any]) -> str:
        if "private_key" not in info:
            raise ValueError("clé")
        return "jeton"

    google = types.ModuleType("google")
    google.__path__ = []  # type: ignore[attr-defined]
    cloud = types.ModuleType("google.cloud")
    cloud.__path__ = []  # type: ignore[attr-defined]
    bq = types.ModuleType("google.cloud.bigquery")
    bq.Client = Client  # type: ignore[attr-defined]
    bq.QueryJobConfig = QueryJobConfig  # type: ignore[attr-defined]
    dbapi = types.ModuleType("google.cloud.bigquery.dbapi")
    dbapi.connect = dbapi_connect  # type: ignore[attr-defined]
    bq.dbapi = dbapi  # type: ignore[attr-defined]
    cloud.bigquery = bq  # type: ignore[attr-defined]
    oauth = types.ModuleType("google.oauth2")
    sa = types.ModuleType("google.oauth2.service_account")
    sa.Credentials = types.SimpleNamespace(from_service_account_info=from_info)  # type: ignore[attr-defined]
    oauth.service_account = sa  # type: ignore[attr-defined]
    for name, mod in {
        "google": google,
        "google.cloud": cloud,
        "google.cloud.bigquery": bq,
        "google.cloud.bigquery.dbapi": dbapi,
        "google.oauth2": oauth,
        "google.oauth2.service_account": sa,
    }.items():
        monkeypatch.setitem(sys.modules, name, mod)
    monkeypatch.setattr(type(DIALECTS["bigquery"]), "driver_installed", lambda self: True)
    return seen


def test_bigquery_service_account_cost_cap_and_tables(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    seen = _fake_bigquery(monkeypatch)
    key = json.dumps({"type": "service_account", "private_key": "-----BEGIN…", "client_email": "viz@p.iam"})
    c = make(client, name="BQ", kind="bigquery", database="mon-projet-123", password=key, max_gb=2)
    assert client.post(f"/api/connections/{c['id']}/test").status_code == 403  # hors ligne
    client.put("/api/settings", json={"online_mode": True})
    assert client.post(f"/api/connections/{c['id']}/test").json()["ok"] is True
    assert seen["project"] == "mon-projet-123" and seen["credentials"] == "jeton"
    assert seen["job_config"]["maximum_bytes_billed"] == 2_000_000_000 and seen["job_config"]["use_legacy_sql"] is False
    tables = client.get(f"/api/connections/{c['id']}/tables").json()["tables"]
    assert [(t["schema"], t["name"], t["kind"]) for t in tables] == [
        ("commerce", "ventes", "table"),
        ("commerce", "v_mois", "view"),
    ]
    assert DIALECTS["bigquery"].quote("ma`table") == "`ma\\`table`"

    bad = make(client, name="BQ2", kind="bigquery", database="mon-projet-123", password="pas du json")
    res = client.post(f"/api/connections/{bad['id']}/test").json()
    assert res["ok"] is False and "Clé de compte de service invalide" in res["message"]


def test_bigquery_project_validation_and_missing_driver(client: TestClient) -> None:
    assert (
        client.post("/api/connections", json={"name": "B", "kind": "bigquery", "database": "Pas Valide"}).status_code
        == 422
    )
    infos = {i["kind"]: i for i in client.get("/api/connections/connectors").json()}
    assert infos["bigquery"]["install_hint"] == "pip install google-cloud-bigquery"
    assert infos["snowflake"]["install_hint"] == "pip install snowflake-connector-python"


def test_long_secret_is_chunked_in_the_keyring() -> None:
    """Clé JSON BigQuery (≈ 2,3 ko) : rangée en morceaux (limite du Gestionnaire d'identifiants Windows)."""
    from app.services.connectors import secrets as mod

    class Errors:
        class PasswordDeleteError(Exception):
            pass

    class FakeKeyring:
        errors = Errors

        def __init__(self) -> None:
            self.store: dict[tuple[str, str], str] = {}

        def get_password(self, service: str, key: str) -> str | None:
            return self.store.get((service, key))

        def set_password(self, service: str, key: str, value: str) -> None:
            assert len(value.encode("utf-16-le")) <= 2560, "trop long pour Windows"
            self.store[(service, key)] = value

        def delete_password(self, service: str, key: str) -> None:
            if self.store.pop((service, key), None) is None:
                raise Errors.PasswordDeleteError

    ring = FakeKeyring()
    secrets = object.__new__(mod.KeyringSecrets)
    secrets._keyring = ring  # type: ignore[attr-defined]
    key = '{"type": "service_account", "private_key": "' + "é" * 2300 + '"}'
    secrets.set("conn:bq", key)
    assert secrets.get("conn:bq") == key and len(ring.store) == 4
    secrets.set("conn:bq", "court")  # morceaux devenus inutiles retirés
    assert secrets.get("conn:bq") == "court" and len(ring.store) == 1
    secrets.set("conn:bq", key)
    secrets.delete("conn:bq")
    assert ring.store == {} and secrets.get("conn:bq") is None
