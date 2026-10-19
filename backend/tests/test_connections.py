"""Connecteurs : registre et secrets, SQLite de bout en bout, fichiers synchronisés, requêtes en lecture seule,
politique réseau hors ligne, SharePoint (Graph simulé), actualisation des jeux importés.

Aucun serveur réel : SQLite est un fichier, Microsoft Graph est simulé par `httpx.MockTransport`.
Les essais sur de vrais PostgreSQL / MySQL sont dans `test_connections_live.py` (ignorés par défaut).
"""

import datetime as dt
import decimal
import io
import json
import socket
import sqlite3
import stat
import uuid
from pathlib import Path
from typing import Any

import httpx
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.schemas.connection import ConnectionFields, TableRef
from app.services.connectors import sql
from app.services.connectors.base import ConnectorError, check_server, rows_to_frame, server_hostname
from app.services.connectors.sharepoint import parse_list_url, share_id


@pytest.fixture
def shop(tmp_path: Path) -> Path:
    """Petite base SQLite : une table, une vue."""
    path = tmp_path / "boutique.db"
    con = sqlite3.connect(path)
    con.executescript(
        """
        CREATE TABLE ventes (id INTEGER PRIMARY KEY, region TEXT, ca REAL, jour TEXT, code TEXT);
        CREATE VIEW grosses_ventes AS SELECT * FROM ventes WHERE ca > 1000;
        """
    )
    rows = [
        (i, ["Occitanie", "Bretagne", "Normandie"][i % 3], 400.0 * i, f"2026-03-{i:02d}", f"{i:05d}")
        for i in range(1, 26)
    ]
    con.executemany("INSERT INTO ventes VALUES (?, ?, ?, ?, ?)", rows)
    con.commit()
    con.close()
    return path


def make(client: TestClient, **fields: Any) -> dict[str, Any]:
    r = client.post("/api/connections", json=fields)
    assert r.status_code == 201, r.text
    return r.json()


# --- Registre et secrets ---------------------------------------------------------------------


def test_connectors_listed_with_driver_state(client: TestClient) -> None:
    infos = {c["kind"]: c for c in client.get("/api/connections/connectors").json()}
    assert set(infos) == {
        "sqlserver", "postgres", "mysql", "sqlite", "file", "sharepoint", "atelier_tab", "atelier_projets"
    }
    assert infos["sqlite"]["driver_installed"] is True
    assert infos["sqlserver"]["default_port"] == 1433
    assert infos["sharepoint"]["needs_online"] is True and infos["sharepoint"]["configured"] is False


def test_password_never_stored_in_clear_nor_returned(client: TestClient, settings) -> None:
    c = make(
        client,
        name="Prod",
        kind="postgres",
        host="127.0.0.1",
        database="ventes",
        username="lecteur",
        password="s3cr3t!",
    )
    assert c["has_password"] is True and "password" not in c
    assert "s3cr3t!" not in (settings.data_dir / "connections.json").read_text()
    secrets = settings.data_dir / "secrets.json"
    assert stat.S_IMODE(secrets.stat().st_mode) == 0o600
    assert "s3cr3t!" in secrets.read_text()
    assert all("password" not in x for x in client.get("/api/connections").json())

    # Modification sans mot de passe : conservé ; chaîne vide : effacé.
    body = {k: c[k] for k in ("name", "kind", "host", "database", "username")} | {"name": "Production"}
    assert client.put(f"/api/connections/{c['id']}", json=body).json()["has_password"] is True
    assert client.put(f"/api/connections/{c['id']}", json=body | {"password": ""}).json()["has_password"] is False
    assert client.delete(f"/api/connections/{c['id']}").status_code == 204
    assert client.get("/api/connections").json() == []
    assert client.delete(f"/api/connections/{c['id']}").status_code == 404


def test_validation_of_required_fields(client: TestClient) -> None:
    assert client.post("/api/connections", json={"name": "x", "kind": "sqlserver"}).status_code == 422
    assert client.post("/api/connections", json={"name": "x", "kind": "sqlite"}).status_code == 422
    c = make(client, name="x", kind="sqlite", path="/tmp/a.db")
    body = {"name": "x", "kind": "postgres", "host": "localhost"}
    assert client.put(f"/api/connections/{c['id']}", json=body).status_code == 422  # le type ne change pas


# --- SQLite de bout en bout --------------------------------------------------------------------


def test_sqlite_tables_preview_import_and_refresh(client: TestClient, shop: Path) -> None:
    c = make(client, name="Boutique", kind="sqlite", path=str(shop))
    test = client.post(f"/api/connections/{c['id']}/test").json()
    assert test["ok"] is True and test["server"].startswith("SQLite")

    tables = client.get(f"/api/connections/{c['id']}/tables").json()["tables"]
    assert {(t["name"], t["kind"]) for t in tables} == {("ventes", "table"), ("grosses_ventes", "view")}

    preview = client.post(f"/api/connections/{c['id']}/preview", json={"table": {"name": "ventes"}, "limit": 5}).json()
    assert preview["truncated"] is True and len(preview["rows"]) == 5
    assert preview["rows"][0] == {"id": 1, "region": "Bretagne", "ca": 400.0, "jour": "2026-03-01", "code": "00001"}

    query = "SELECT region, SUM(ca) AS total FROM ventes GROUP BY region ORDER BY region;"
    q = client.post(f"/api/connections/{c['id']}/preview", json={"query": query}).json()
    assert q["truncated"] is False and [r["region"] for r in q["rows"]] == ["Bretagne", "Normandie", "Occitanie"]

    created = client.post(f"/api/connections/{c['id']}/import", json={"table": {"name": "ventes"}})
    assert created.status_code == 201, created.text
    ds = created.json()
    assert ds["name"] == "ventes" and ds["format"] == "sqlite" and ds["rows"] == 25
    assert ds["origin"]["connection_id"] == c["id"] and ds["origin"]["table"]["name"] == "ventes"
    types = {col["name"]: col["type"] for col in ds["columns"]}
    # Les types de la base sont gardés : le code reste du texte (zéros en tête conservés).
    assert types == {"id": "number", "region": "string", "ca": "number", "jour": "string", "code": "string"}

    # Mesure calculée, puis nouvelles lignes dans la source : l'actualisation garde l'identifiant et le modèle.
    model = {
        "columns": [{"name": "ca_ttc", "expression": "ca * 1.2"}],
        "measures": [{"name": "Total", "expression": "SUM(ca)"}],
    }
    assert client.put(f"/api/datasets/{ds['id']}/model", json=model).status_code == 200
    con = sqlite3.connect(shop)
    con.execute("INSERT INTO ventes VALUES (99, 'Corse', 10.0, '2026-04-01', '00099')")
    con.commit()
    con.close()
    refreshed = client.post(f"/api/datasets/{ds['id']}/refresh")
    assert refreshed.status_code == 200, refreshed.text
    r = refreshed.json()
    assert r["id"] == ds["id"] and r["rows"] == 26 and r["model"]["measures"][0]["name"] == "Total"
    assert "ca_ttc" in {col["name"] for col in r["columns"]}
    assert r["origin"]["refreshed_at"] >= ds["origin"]["refreshed_at"]
    total = client.post(
        "/api/query", json={"dataset_id": ds["id"], "measures": [{"field": "Total", "agg": "calc"}]}
    ).json()
    assert total["rows"][0][0] == pytest.approx(sum(400.0 * i for i in range(1, 26)) + 10)


def test_refresh_refused_when_model_no_longer_fits(client: TestClient, shop: Path) -> None:
    c = make(client, name="Boutique", kind="sqlite", path=str(shop))
    q = client.post(f"/api/connections/{c['id']}/import", json={"query": "SELECT id, ca FROM ventes"}).json()
    assert q["name"] == "Boutique (requête)" and q["origin"]["query"] == "SELECT id, ca FROM ventes"
    ds = client.post(f"/api/connections/{c['id']}/import", json={"table": {"name": "ventes"}}).json()
    client.put(
        f"/api/datasets/{ds['id']}/model",
        json={"columns": [{"name": "double", "expression": "ca * 2"}], "measures": []},
    )
    # La source change : la colonne « ca » disparaît.
    con = sqlite3.connect(shop)
    con.executescript("ALTER TABLE ventes RENAME COLUMN ca TO montant;")
    con.close()
    r = client.post(f"/api/datasets/{ds['id']}/refresh")
    assert r.status_code == 409
    assert client.get(f"/api/datasets/{ds['id']}").json()["rows"] == 25  # rien n'a changé


def test_refresh_errors(client: TestClient, shop: Path) -> None:
    csv = b"a;b\n1;2\n"
    uploaded = client.post("/api/datasets", files={"file": ("x.csv", csv, "text/csv")}).json()
    assert client.post(f"/api/datasets/{uploaded['id']}/refresh").status_code == 422
    c = make(client, name="Boutique", kind="sqlite", path=str(shop))
    ds = client.post(f"/api/connections/{c['id']}/import", json={"table": {"name": "ventes"}, "max_rows": 10}).json()
    assert ds["rows"] == 10 and ds["origin"]["truncated"] is True and ds["origin"]["max_rows"] == 10
    client.delete(f"/api/connections/{c['id']}")
    r = client.post(f"/api/datasets/{ds['id']}/refresh")
    assert r.status_code == 409 and "supprimée" in r.json()["detail"]


def test_sqlite_is_opened_read_only(client: TestClient, shop: Path) -> None:
    c = make(client, name="Boutique", kind="sqlite", path=str(shop))
    # Même si le filtre laissait passer une écriture, le fichier est ouvert en lecture seule.
    with sql.connect(ConnectionFields(name="b", kind="sqlite", path=str(shop)), None, 5, 5) as conn:
        with pytest.raises(sqlite3.OperationalError):
            conn.cursor().execute("DELETE FROM ventes")
    r = client.post(f"/api/connections/{c['id']}/preview", json={"query": "DELETE FROM ventes"})
    assert r.status_code == 422 and "lecture" in r.json()["detail"]
    missing = make(client, name="Absente", kind="sqlite", path=str(shop.parent / "absente.db"))
    t = client.post(f"/api/connections/{missing['id']}/test").json()
    assert t["ok"] is False and "introuvable" in t["message"]


# --- Requêtes en lecture seule -----------------------------------------------------------------


@pytest.mark.parametrize(
    "query",
    [
        "SELECT * FROM t",
        "  with x as (select 1 as a) select * from x ;  ",
        "SELECT 'insert into t; drop table x' AS texte, \"delete\" FROM t -- update t\n",
        "SELECT [into] FROM [dbo].[t]]x] /* drop */",
        "SELECT REPLACE(nom, 'a', 'b'), commentaire, \"set\" FROM t",
    ],
)
def test_check_query_accepts_reads(query: str) -> None:
    assert not sql.check_query(query).endswith(";")


@pytest.mark.parametrize(
    ("query", "fragment"),
    [
        ("", "vide"),
        ("DELETE FROM t", "SELECT ou WITH"),
        ("UPDATE t SET a = 1", "SELECT ou WITH"),
        ("SELECT 1; DROP TABLE t", "Une seule"),
        ("SELECT * INTO copie FROM t", "INTO"),
        ("WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x", "DELETE"),
        ("SELECT * FROM OPENROWSET('SQLNCLI', 'srv', 'q')", "OPENROWSET"),
        ("SELECT 'non fermée FROM t", "non fermé"),
        ("SELECT 1 /* commentaire", "non fermé"),
        ("EXEC sp_who", "SELECT ou WITH"),
    ],
)
def test_check_query_refuses_writes(query: str, fragment: str) -> None:
    with pytest.raises(ConnectorError) as err:
        sql.check_query(query)
    assert fragment in err.value.message


def test_dialects_quote_and_limit() -> None:
    ref = TableRef(schema="dbo", name="Ventes]2026")
    assert sql.DIALECTS["sqlserver"].select_table(ref, 51) == "SELECT TOP (51) * FROM [dbo].[Ventes]]2026]"
    assert (
        sql.DIALECTS["postgres"].select_table(TableRef(schema="public", name='a"b'), 10)
        == 'SELECT * FROM "public"."a""b" LIMIT 10'
    )
    assert sql.DIALECTS["mysql"].select_table(TableRef(name="a`b"), None) == "SELECT * FROM `a``b`"


# --- Conversion des lignes ---------------------------------------------------------------------


def test_rows_to_frame_keeps_database_types() -> None:
    utc = dt.UTC
    rows = [
        (
            decimal.Decimal("12.50"),
            dt.date(2026, 1, 2),
            True,
            "00123",
            uuid.UUID(int=1),
            b"\x00",
            dt.datetime(2026, 1, 2, 10, tzinfo=utc),
        ),
        (None, None, None, None, None, None, None),
    ]
    df = rows_to_frame(["montant", "jour", "actif", "code", "uid", "blob", None], rows)
    assert list(df.columns) == ["montant", "jour", "actif", "code", "uid", "blob", "colonne_7"]
    assert pd.api.types.is_float_dtype(df["montant"]) and df["montant"][0] == 12.5
    assert pd.api.types.is_datetime64_any_dtype(df["jour"])
    assert str(df["actif"].dtype) == "boolean"
    assert df["code"][0] == "00123" and df["uid"][0] == str(uuid.UUID(int=1))
    assert df["blob"].isna().all()
    assert df["colonne_7"].dt.tz is None and df["colonne_7"][0] == pd.Timestamp("2026-01-02 10:00")
    assert list(rows_to_frame(["a", "a", ""], []).columns) == ["a", "a_2", "colonne_3"]


# --- Politique réseau --------------------------------------------------------------------------


def test_server_hostname_variants() -> None:
    assert server_hostname("tcp:sql01.corp\\PROD,1433") == "sql01.corp"
    assert server_hostname("db.example.com:5432") == "db.example.com"
    assert server_hostname("[::1]") == "::1"


def test_offline_allows_private_networks_only(monkeypatch: pytest.MonkeyPatch) -> None:
    table = {"sql01.corp": "10.1.2.3", "db.example.com": "93.184.216.34"}

    def fake(host: str, *_: object, **__: object) -> list[tuple[Any, ...]]:
        if host not in table:
            raise socket.gaierror("introuvable")
        return [(socket.AF_INET, 0, 0, "", (table[host], 0))]

    monkeypatch.setattr(socket, "getaddrinfo", fake)
    check_server("sql01.corp\\PROD", online=False)
    check_server("localhost", online=False)
    with pytest.raises(ConnectorError) as err:
        check_server("db.example.com", online=False)
    assert err.value.status_code == 403
    check_server("db.example.com", online=True)
    with pytest.raises(ConnectorError) as err:
        check_server("inconnu.corp", online=False)
    assert err.value.status_code == 422


def test_offline_refuses_public_database_over_api(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [(socket.AF_INET, 0, 0, "", ("93.184.216.34", 0))])
    body = {"name": "Cloud", "kind": "postgres", "host": "db.example.com", "password": "x"}
    r = client.post("/api/connections/test", json=body)
    assert r.status_code == 403 and "En ligne" in r.json()["detail"]


def test_missing_driver_is_explained(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sql.Dialect, "driver_installed", lambda self: self.kind != "sqlserver")
    infos = {c["kind"]: c for c in client.get("/api/connections/connectors").json()}
    assert infos["sqlserver"]["install_hint"] == "pip install pymssql"
    r = client.post("/api/connections/test", json={"name": "SQL", "kind": "sqlserver", "host": "localhost"})
    assert r.json() == {
        "ok": False,
        "message": "Pilote SQL Server absent : dans le dossier backend, lancez « pip install pymssql ».",
        "server": None,
    }


# --- Fichiers synchronisés (OneDrive / SharePoint / partage réseau) ----------------------------


def test_synced_excel_file_with_sheets(client: TestClient, tmp_path: Path) -> None:
    path = tmp_path / "OneDrive - Contoso" / "Objectifs.xlsx"
    path.parent.mkdir()
    with pd.ExcelWriter(path) as xl:
        pd.DataFrame({"region": ["Occitanie", "Bretagne"], "objectif": [1000, 2000]}).to_excel(
            xl, sheet_name="2026", index=False
        )
        pd.DataFrame({"mois": ["janv.", "févr."], "taux": [0.1, 0.2]}).to_excel(
            xl, sheet_name="Saisonnalité", index=False
        )
    c = make(client, name="Objectifs", kind="file", path=str(path))
    assert client.post(f"/api/connections/{c['id']}/test").json()["ok"] is True
    sheets = client.get(f"/api/connections/{c['id']}/tables").json()["tables"]
    assert [(s["name"], s["kind"]) for s in sheets] == [("2026", "sheet"), ("Saisonnalité", "sheet")]
    ds = client.post(
        f"/api/connections/{c['id']}/import", json={"table": {"name": "Saisonnalité", "kind": "sheet"}}
    ).json()
    assert ds["name"] == "Objectifs — Saisonnalité" and ds["format"] == "xlsx" and ds["rows"] == 2

    with pd.ExcelWriter(path) as xl:  # le fichier est mis à jour par la synchronisation
        pd.DataFrame({"mois": ["janv.", "févr.", "mars"], "taux": [0.1, 0.2, 0.3]}).to_excel(
            xl, sheet_name="Saisonnalité", index=False
        )
    assert client.post(f"/api/datasets/{ds['id']}/refresh").json()["rows"] == 3

    bad = make(client, name="Image", kind="file", path=str(tmp_path / "photo.png"))
    assert client.post(f"/api/connections/{bad['id']}/test").json()["ok"] is False


# --- SharePoint Online (Microsoft Graph simulé) ------------------------------------------------

SITE = "https://contoso.sharepoint.com/sites/Ventes"
FILE_URL = f"{SITE}/Documents%20partages/objectifs.csv"
LIST_URL = f"{SITE}/Lists/Commandes/AllItems.aspx"


def graph(request: httpx.Request) -> httpx.Response:
    url, path = str(request.url), request.url.path
    if path.endswith("/devicecode"):
        return httpx.Response(
            200,
            json={
                "device_code": "DC",
                "user_code": "ABCD-1234",
                "verification_uri": "https://microsoft.com/devicelogin",
                "expires_in": 900,
                "interval": 1,
                "message": "Saisissez ABCD-1234",
            },
        )
    if path.endswith("/token"):
        form = dict(x.split("=", 1) for x in request.content.decode().split("&"))
        if form.get("grant_type") == "refresh_token":
            return httpx.Response(200, json={"access_token": "AT2", "expires_in": 3600})
        return httpx.Response(200, json={"access_token": "AT", "refresh_token": "RT", "expires_in": 3600})
    assert request.headers["Authorization"] in {"Bearer AT", "Bearer AT2"}
    if path == "/v1.0/me":
        return httpx.Response(200, json={"userPrincipalName": "francois@contoso.fr"})
    if path == f"/v1.0/shares/{share_id(FILE_URL)}/driveItem":
        return httpx.Response(
            200, json={"id": "F1", "name": "objectifs.csv", "size": 40, "parentReference": {"driveId": "D1"}}
        )
    if path == "/v1.0/drives/D1/items/F1/content":
        return httpx.Response(200, content=b"region;objectif\nOccitanie;1 000,5\nBretagne;2 000\n")
    if path == "/v1.0/sites/contoso.sharepoint.com:/sites/Ventes":
        return httpx.Response(200, json={"id": "S1"})
    if path == "/v1.0/sites/S1/lists":
        return httpx.Response(
            200,
            json={
                "value": [
                    {"id": "L0", "name": "Docs", "webUrl": f"{SITE}/Shared%20Documents"},
                    {"id": "L1", "name": "Commandes", "displayName": "Commandes", "webUrl": f"{SITE}/Lists/Commandes"},
                ]
            },
        )
    if path == "/v1.0/sites/S1/lists/L1/columns":
        return httpx.Response(200, json={"value": [
            {"name": "Title", "displayName": "Titre"}, {"name": "Montant", "displayName": "Montant"},
            {"name": "Client", "displayName": "Client"}, {"name": "_Hidden", "hidden": True},
            {"name": "Modified", "displayName": "Modifié", "readOnly": True}, {"name": "Author", "readOnly": True},
        ]})  # fmt: skip
    if path == "/v1.0/sites/S1/lists/L1/items":
        if "skiptoken" in url:
            return httpx.Response(
                200,
                json={
                    "value": [
                        {
                            "fields": {
                                "Title": "C3",
                                "Montant": 30,
                                "Client": {"LookupValue": "Gamma"},
                                "Modified": "2026-03-03T10:00:00Z",
                            }
                        }
                    ]
                },
            )
        return httpx.Response(200, json={
            "value": [
                {"fields": {"Title": "C1", "Montant": 10.5, "Client": {"LookupValue": "Alpha"},
                            "Modified": "2026-03-01T10:00:00Z", "_Hidden": 1}},
                {"fields": {"Title": "C2", "Montant": 20, "Client": {"LookupValue": "Beta"},
                            "Modified": "2026-03-02T10:00:00Z"}},
            ],
            "@odata.nextLink": "https://graph.microsoft.com/v1.0/sites/S1/lists/L1/items?skiptoken=2",
        })  # fmt: skip
    return httpx.Response(404, json={"error": {"message": "inconnu"}})


@pytest.fixture
def sharepoint(client: TestClient) -> dict[str, Any]:
    client.app.state.connections.http_factory = lambda: httpx.Client(transport=httpx.MockTransport(graph))  # type: ignore[attr-defined]
    return make(
        client, name="Contoso", kind="sharepoint", client_id="00000000-0000-0000-0000-000000000001", tenant="contoso.fr"
    )


def test_sharepoint_requires_online_mode_and_login(client: TestClient, sharepoint: dict[str, Any]) -> None:
    cid = sharepoint["id"]
    r = client.post(f"/api/connections/{cid}/login")
    assert r.status_code == 403 and "En ligne" in r.json()["detail"]
    client.put("/api/settings", json={"online_mode": True})
    r = client.post(f"/api/connections/{cid}/preview", json={"url": FILE_URL})
    assert r.status_code == 401 and "Connectez-vous" in r.json()["detail"]

    start = client.post(f"/api/connections/{cid}/login").json()
    assert start["user_code"] == "ABCD-1234"
    status = client.post(f"/api/connections/{cid}/login/poll").json()
    assert status == {"status": "signed_in", "account": "francois@contoso.fr", "message": None}
    listed = client.get("/api/connections").json()[0]
    assert listed["signed_in"] is True and listed["account"] == "francois@contoso.fr"
    assert "AT" not in json.dumps(listed)
    assert client.post(f"/api/connections/{cid}/test").json()["ok"] is True

    # Fichier CSV d'une bibliothèque (format français) puis liste SharePoint paginée.
    ds = client.post(f"/api/connections/{cid}/import", json={"url": FILE_URL}).json()
    assert ds["name"] == "objectifs.csv" and ds["format"] == "csv" and ds["rows"] == 2
    assert {c["name"]: c["type"] for c in ds["columns"]} == {"region": "string", "objectif": "number"}

    lst = client.post(f"/api/connections/{cid}/import", json={"url": LIST_URL}).json()
    assert lst["name"] == "Commandes" and lst["format"] == "sharepoint" and lst["rows"] == 3
    cols = {c["name"]: c["type"] for c in lst["columns"]}
    assert cols == {"Titre": "string", "Montant": "number", "Client": "string", "Modifié": "date"}
    assert [r["Client"] for r in lst["sample"]] == ["Alpha", "Beta", "Gamma"]

    # Hors ligne : plus d'accès à SharePoint, même connecté.
    client.put("/api/settings", json={"online_mode": False})
    assert client.post(f"/api/datasets/{lst['id']}/refresh").status_code == 403
    client.put("/api/settings", json={"online_mode": True})
    assert client.post(f"/api/datasets/{lst['id']}/refresh").status_code == 200

    out = client.post(f"/api/connections/{cid}/logout").json()
    assert out["signed_in"] is False


def test_sharepoint_needs_an_application(client: TestClient) -> None:
    client.put("/api/settings", json={"online_mode": True})
    c = make(client, name="SP", kind="sharepoint")
    r = client.post(f"/api/connections/{c['id']}/login")
    assert r.status_code == 412 and "SHAREPOINT_CLIENT_ID" in r.json()["detail"]


def test_sharepoint_urls() -> None:
    assert parse_list_url(LIST_URL) == ("contoso.sharepoint.com", "/sites/Ventes")
    assert parse_list_url(FILE_URL) is None
    assert share_id("https://a.sharepoint.com/x") == "u!aHR0cHM6Ly9hLnNoYXJlcG9pbnQuY29tL3g"


def test_unknown_connection_is_404(client: TestClient) -> None:
    assert client.get("/api/connections/abc/tables").status_code == 404
    assert client.post("/api/connections/abc/preview", json={}).status_code == 404


def test_excel_bytes_helper() -> None:
    from app.services.data.parsing import excel_sheets

    buf = io.BytesIO()
    with pd.ExcelWriter(buf) as xl:
        pd.DataFrame({"a": [1]}).to_excel(xl, sheet_name="Une", index=False)
    assert excel_sheets(buf.getvalue()) == ["Une"]


def test_driver_errors_are_readable() -> None:
    from app.services.connectors.base import short

    tds = b"DB-Lib error message 20009, severity 9:\nUnable to connect (srv)\n" * 2
    assert short(Exception((20009, tds))) == "Unable to connect (srv)"
    assert short(Exception("a\n  b\n")) == "a — b"
    assert len(short(Exception("x" * 1000))) == 400
