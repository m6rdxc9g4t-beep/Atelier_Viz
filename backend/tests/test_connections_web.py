"""Connecteur « Fichier web » : URL http(s) simulée par `httpx.MockTransport` (aucun réseau réel).

Politique réseau : hors ligne, adresse privée seulement, connexion à l'IP validée ; redirections
revérifiées ; jeton jamais envoyé à un autre hôte ; taille bornée ; jeton au trousseau.
"""

import io
import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.services.connectors import web
from app.services.connectors.base import ConnectorError

CSV = b"region;ca\nNord;100\nSud;250\n"


def xlsx() -> bytes:
    buf = io.BytesIO()
    with pd.ExcelWriter(buf, engine="openpyxl") as w:
        pd.DataFrame({"mois": ["janv.", "févr."], "objectif": [10, 20]}).to_excel(
            w, sheet_name="Objectifs", index=False
        )
        pd.DataFrame({"x": [1]}).to_excel(w, sheet_name="Notes", index=False)
    return buf.getvalue()


Handler = Callable[[httpx.Request], httpx.Response]


def install(client: TestClient, handler: Handler) -> list[httpx.Request]:
    """Remplace le client HTTP du connecteur ; retourne la liste des requêtes reçues."""
    seen: list[httpx.Request] = []

    def record(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    client.app.state.connections.web_http_factory = lambda online: httpx.Client(  # type: ignore[attr-defined]
        transport=httpx.MockTransport(record), follow_redirects=False
    )
    return seen


def make(client: TestClient, **fields: Any) -> dict[str, Any]:
    r = client.post("/api/connections", json={"name": "Web", "kind": "web", **fields})
    assert r.status_code == 201, r.text
    return r.json()


def test_csv_by_url_preview_import_and_refresh(client: TestClient) -> None:
    body = {"data": CSV}
    seen = install(client, lambda req: httpx.Response(200, content=body["data"], headers={"content-type": "text/csv"}))
    c = make(client, base_url="http://127.0.0.1:8080/exports/ventes.csv")
    assert client.post(f"/api/connections/{c['id']}/test").json()["ok"] is True
    preview = client.post(f"/api/connections/{c['id']}/preview", json={}).json()
    assert preview["columns"] == ["region", "ca"] and len(preview["rows"]) == 2

    ds = client.post(f"/api/connections/{c['id']}/import", json={}).json()
    assert ds["name"] == "ventes.csv" and ds["rows"] == 2
    assert ds["origin"]["kind"] == "web"

    body["data"] = CSV + b"Est;40\n"
    refreshed = client.post(f"/api/datasets/{ds['id']}/refresh")
    assert refreshed.status_code == 200, refreshed.text
    assert refreshed.json()["rows"] == 3
    assert all(r.method == "GET" and "authorization" not in r.headers for r in seen)


def test_excel_sheets_and_token_in_keyring(client: TestClient, settings) -> None:  # type: ignore[no-untyped-def]
    seen = install(
        client,
        lambda req: httpx.Response(
            200,
            content=xlsx(),
            headers={"content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"},
        ),
    )
    c = make(client, base_url="http://localhost/api/export?format=xlsx", password="jeton-secret")
    assert c["has_password"] is True
    assert "jeton-secret" not in (Path(settings.data_dir) / "connections.json").read_text(encoding="utf-8")
    tables = client.get(f"/api/connections/{c['id']}/tables").json()["tables"]
    assert [t["name"] for t in tables] == ["Objectifs", "Notes"]
    ds = client.post(
        f"/api/connections/{c['id']}/import", json={"table": {"name": "Objectifs", "kind": "sheet"}}
    ).json()
    assert ds["name"] == "export — Objectifs" and ds["rows"] == 2
    assert seen[-1].headers["authorization"] == "Bearer jeton-secret"


def test_offline_refuses_internet_and_pins_private_ip(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    seen = install(client, lambda req: httpx.Response(200, content=CSV, headers={"content-type": "text/csv"}))
    public = make(client, base_url="https://93.184.216.34/data.csv")
    r = client.post(f"/api/connections/{public['id']}/test")
    assert r.status_code == 403 and "hors ligne" in r.json()["detail"]
    assert not seen

    # Nom privé : résolu une fois, connexion à l'adresse validée, Host d'origine conservé.
    monkeypatch.setattr(web, "resolve_local", lambda host: "10.1.2.3")
    lan = make(client, base_url="http://intranet.entreprise.lan/ventes.csv")
    assert client.post(f"/api/connections/{lan['id']}/test").json()["ok"] is True
    assert seen[-1].url.host == "10.1.2.3"
    assert seen[-1].headers["host"] == "intranet.entreprise.lan"

    # En ligne : toute adresse http(s).
    client.put("/api/settings", json={"online_mode": True})
    assert client.post(f"/api/connections/{public['id']}/test").json()["ok"] is True


def test_redirects_are_rechecked_and_token_stays_on_origin(client: TestClient) -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.path == "/a.csv":
            return httpx.Response(302, headers={"location": "http://127.0.0.2/b.csv"})
        if req.url.path == "/b.csv":
            return httpx.Response(200, content=CSV, headers={"content-type": "text/csv"})
        if req.url.path == "/loin.csv":
            return httpx.Response(302, headers={"location": "https://93.184.216.34/x.csv"})
        return httpx.Response(302, headers={"location": req.url.path})

    seen = install(client, handler)
    c = make(client, base_url="http://127.0.0.1/a.csv", password="t")
    assert client.post(f"/api/connections/{c['id']}/test").json()["ok"] is True
    assert seen[0].headers["authorization"] == "Bearer t"
    assert "authorization" not in seen[1].headers  # autre hôte : jamais le jeton

    far = make(client, base_url="http://127.0.0.1/loin.csv")
    assert client.post(f"/api/connections/{far['id']}/test").status_code == 403

    loop = make(client, base_url="http://127.0.0.1/boucle")
    res = client.post(f"/api/connections/{loop['id']}/test").json()
    assert res["ok"] is False and "redirections" in res["message"]


@pytest.mark.parametrize(
    ("response", "message"),
    [
        (httpx.Response(404), "introuvable"),
        (httpx.Response(401), "Accès refusé"),
        (httpx.Response(200, content=b"<html></html>", headers={"content-type": "text/html"}), "Format non reconnu"),
        (httpx.Response(200, content=b"x" * 2_000_001, headers={"content-type": "text/csv"}), "trop volumineux"),
    ],
)
def test_errors_are_readable(client: TestClient, settings, response: httpx.Response, message: str) -> None:  # type: ignore[no-untyped-def]
    settings.connector_max_file_mb = 2
    install(client, lambda req: response)
    c = make(client, base_url="http://127.0.0.1/fichier")
    res = client.post(f"/api/connections/{c['id']}/test").json()
    assert res["ok"] is False and message in res["message"]


def test_content_disposition_and_json(client: TestClient) -> None:
    payload = json.dumps([{"a": 1}, {"a": 2}]).encode()
    install(
        client,
        lambda req: httpx.Response(
            200,
            content=payload,
            headers={
                "content-type": "application/octet-stream",
                "content-disposition": 'attachment; filename="stock.json"',
            },
        ),
    )
    c = make(client, base_url="http://127.0.0.1/telecharger?id=4")
    ds = client.post(f"/api/connections/{c['id']}/import", json={}).json()
    assert ds["name"] == "stock.json" and ds["rows"] == 2


@pytest.mark.parametrize(
    "url", ["ftp://serveur/f.csv", "file:///etc/passwd", "https://moi:secret@serveur/f.csv", "", "pas une adresse"]
)
def test_invalid_urls_are_refused(client: TestClient, url: str) -> None:
    r = client.post("/api/connections", json={"name": "W", "kind": "web", "base_url": url})
    assert r.status_code == 422


def test_check_url_rejects_credentials() -> None:
    with pytest.raises(ConnectorError):
        web.check_url("https://a:b@exemple.fr/x.csv")
