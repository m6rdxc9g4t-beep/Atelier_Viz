"""Connecteurs de la Suite Atelier (docs/SUITE.md §4.2 et §4.3).

- Atelier Tab : dossier d'instantanés DataFlow dans un répertoire temporaire (aucun réseau).
- Atelier Projets : API simulée par `httpx.MockTransport` (aucun réseau réel).
"""

import json
import os
import shutil
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.services.connectors.atelier import projets_frame
from main import create_app

FIXTURES = Path(__file__).parent / "fixtures"


def make(client: TestClient, **fields: Any) -> dict[str, Any]:
    r = client.post("/api/connections", json=fields)
    assert r.status_code == 201, r.text
    return r.json()


@pytest.fixture
def exports(tmp_path: Path) -> Path:
    """Dossier d'instantanés : deux tables publiées, plus des fichiers à ignorer."""
    folder = tmp_path / "Atelier_Tab" / "exports"
    folder.mkdir(parents=True)
    shutil.copy(FIXTURES / "dataflow_planning.json", folder / "tbl_planning_lots.json")
    shutil.copy(FIXTURES / "dataflow_materiaux.json", folder / "tbl_materiaux.json")
    (folder / "notes.json").write_text('[{"a": 1}]', encoding="utf-8")  # pas une enveloppe
    (folder / "tbl_tmp.json").write_text("{ en cours d'écriture", encoding="utf-8")
    (folder / "lisez-moi.txt").write_text("rien", encoding="utf-8")
    return folder


# --- Atelier Tab ------------------------------------------------------------------------------------


def test_atelier_tab_lists_imports_and_refreshes(client: TestClient, exports: Path) -> None:
    infos = {c["kind"]: c for c in client.get("/api/connections/connectors").json()}
    assert infos["atelier_tab"]["default_location"].replace("\\", "/").endswith("Atelier_Tab/exports")
    assert infos["atelier_tab"]["driver_installed"] is True and infos["atelier_tab"]["needs_online"] is False

    c = make(client, name="Atelier Tab", kind="atelier_tab", path=str(exports))
    test = client.post(f"/api/connections/{c['id']}/test").json()
    assert test["ok"] is True and "2 tables publiées" in test["message"]

    listing = client.get(f"/api/connections/{c['id']}/tables").json()
    assert listing["location"] == str(exports)
    tables = listing["tables"]
    assert [(t["schema"], t["name"], t["id"], t["kind"], t["rows"]) for t in tables] == [
        ("Chiffrage Matériaux", "Matériaux", "tbl_materiaux", "snapshot", 3),
        ("Rénovation Urbaine 2026", "Planning & Lots", "tbl_planning_lots", "snapshot", 3),
    ]
    assert tables[1]["updated_at"].startswith("2026-10-18T12:57")

    planning = tables[1]
    preview = client.post(f"/api/connections/{c['id']}/preview", json={"table": planning, "limit": 2}).json()
    assert preview["truncated"] is True and preview["columns"][:3] == ["_ligne", "_id", "Lot / Tâche"]
    assert preview["rows"][0]["Coût TTC"] == 54000

    r = client.post(f"/api/connections/{c['id']}/import", json={"table": planning})
    assert r.status_code == 201, r.text
    ds = r.json()
    assert ds["name"] == "Planning & Lots" and ds["format"] == "atelier_tab" and ds["rows"] == 3
    assert ds["origin"]["kind"] == "atelier_tab" and ds["origin"]["table"]["id"] == "tbl_planning_lots"
    assert {c["name"]: c["type"] for c in ds["columns"]}["Échéance"] == "date"

    # Atelier Tab republie la table (une ligne de plus) : l'actualisation relit l'instantané.
    data = json.loads((exports / "tbl_planning_lots.json").read_text(encoding="utf-8"))
    new = json.loads(json.dumps(data["project"]["records"][0]))
    new.update(row_index=4, record_id="rec_04")
    new["values"]["C"]["computed"] = 10000
    data["project"]["records"].append(new)
    (exports / "tbl_planning_lots.json").write_text(json.dumps(data), encoding="utf-8")
    refreshed = client.post(f"/api/datasets/{ds['id']}/refresh")
    assert refreshed.status_code == 200, refreshed.text
    assert refreshed.json()["id"] == ds["id"] and refreshed.json()["rows"] == 4

    # Table supprimée dans Atelier Tab : message clair, données conservées.
    (exports / "tbl_planning_lots.json").unlink()
    gone = client.post(f"/api/datasets/{ds['id']}/refresh")
    assert gone.status_code == 404 and "n'est plus publiée" in gone.json()["detail"]
    assert client.get(f"/api/datasets/{ds['id']}").json()["rows"] == 4


def test_atelier_tab_default_folder_and_errors(settings: Settings, tmp_path: Path) -> None:
    folder = tmp_path / "defaut"
    settings.atelier_tab_exports_dir = folder
    with TestClient(create_app(settings)) as client:
        c = make(client, name="Atelier Tab", kind="atelier_tab")  # dossier vide = dossier par défaut
        missing = client.get(f"/api/connections/{c['id']}/tables")
        assert missing.status_code == 404 and "Dossier introuvable" in missing.json()["detail"]
        assert client.post(f"/api/connections/{c['id']}/test").json()["ok"] is False

        folder.mkdir()
        assert client.get(f"/api/connections/{c['id']}/tables").json() == {
            "tables": [],
            "truncated": False,
            "projects": [],
            "location": str(folder),
        }
        bad = client.post(f"/api/connections/{c['id']}/preview", json={"table": {"name": "x", "id": "../secret"}})
        assert bad.status_code == 422
        none = client.post(f"/api/connections/{c['id']}/preview", json={})
        assert none.status_code == 422 and "Choisissez" in none.json()["detail"]


def test_atelier_tab_snapshot_size_limit(settings: Settings, exports: Path) -> None:
    settings.atelier_tab_max_snapshot_mb = 1
    big = json.loads((exports / "tbl_materiaux.json").read_text(encoding="utf-8"))
    big["project"]["padding"] = "x" * 1_200_000  # > 1 Mo
    (exports / "tbl_enorme.json").write_text(json.dumps(big), encoding="utf-8")
    with TestClient(create_app(settings)) as client:
        c = make(client, name="Atelier Tab", kind="atelier_tab", path=str(exports))
        tables = {t["id"]: t for t in client.get(f"/api/connections/{c['id']}/tables").json()["tables"]}
        # Listé sans être lu, avec l'explication ; les autres tables restent disponibles.
        assert set(tables) == {"tbl_enorme", "tbl_materiaux", "tbl_planning_lots"}
        assert "trop volumineux" in tables["tbl_enorme"]["description"] and tables["tbl_enorme"]["rows"] is None
        r = client.post(f"/api/connections/{c['id']}/preview", json={"table": tables["tbl_enorme"]})
        assert r.status_code == 413
        assert "max 1 Mo" in r.json()["detail"] and "ATELIER_TAB_MAX_SNAPSHOT_MB" in r.json()["detail"]
        ok = client.post(f"/api/connections/{c['id']}/preview", json={"table": tables["tbl_materiaux"]})
        assert ok.status_code == 200
    assert Settings(_env_file=None).atelier_tab_max_snapshot_mb == 50  # type: ignore[call-arg]


def test_atelier_tab_metadata_cache(client: TestClient, exports: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services.connectors import atelier

    atelier.SNAPSHOT_INFO_CACHE.clear()
    parsed: list[str] = []
    real_parse = atelier._parse

    def counting(raw: bytes, name: str) -> dict[str, Any]:
        parsed.append(name)
        return real_parse(raw, name)

    monkeypatch.setattr(atelier, "_parse", counting)
    c = make(client, name="Atelier Tab", kind="atelier_tab", path=str(exports))
    assert client.post(f"/api/connections/{c['id']}/test").json()["ok"] is True
    first = sorted(parsed)
    # Les deux instantanés et les deux JSON qui n'en sont pas : lus une fois.
    assert first == ["notes.json", "tbl_materiaux.json", "tbl_planning_lots.json", "tbl_tmp.json"]

    parsed.clear()
    client.get(f"/api/connections/{c['id']}/tables")
    client.post(f"/api/connections/{c['id']}/test")
    assert parsed == []  # rien n'a changé : aucune relecture

    # Atelier Tab republie une table : seule celle-ci est relue, et la liste est à jour.
    path = exports / "tbl_materiaux.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["project"]["source_table"]["name"] = "Matériaux v2"
    path.write_text(json.dumps(data), encoding="utf-8")
    os.utime(path, ns=(time.time_ns(), time.time_ns() + 5_000_000_000))
    names = [t["name"] for t in client.get(f"/api/connections/{c['id']}/tables").json()["tables"]]
    assert parsed == ["tbl_materiaux.json"] and "Matériaux v2" in names

    # Le fichier en cours d'écriture est terminé : il apparaît.
    shutil.copy(FIXTURES / "dataflow_planning.json", exports / "tbl_tmp.json")
    parsed.clear()
    ids = [t["id"] for t in client.get(f"/api/connections/{c['id']}/tables").json()["tables"]]
    assert parsed == ["tbl_tmp.json"] and "tbl_tmp" in ids


def test_atelier_tab_symlinks_cannot_leave_the_folder(client: TestClient, exports: Path, tmp_path: Path) -> None:
    outside = tmp_path / "ailleurs"
    outside.mkdir()
    shutil.copy(FIXTURES / "dataflow_planning.json", outside / "secret.json")
    (exports / "tbl_fuite.json").symlink_to(outside / "secret.json")
    (exports / "tbl_casse.json").symlink_to(outside / "absent.json")
    # Lien interne au dossier : accepté.
    (exports / "tbl_alias.json").symlink_to(exports / "tbl_materiaux.json")

    c = make(client, name="Atelier Tab", kind="atelier_tab", path=str(exports))
    ids = {t["id"] for t in client.get(f"/api/connections/{c['id']}/tables").json()["tables"]}
    assert ids == {"tbl_alias", "tbl_materiaux", "tbl_planning_lots"}
    r = client.post(f"/api/connections/{c['id']}/preview", json={"table": {"name": "x", "id": "tbl_fuite"}})
    assert r.status_code == 403 and "hors du dossier" in r.json()["detail"]
    r = client.post(f"/api/connections/{c['id']}/preview", json={"table": {"name": "x", "id": "tbl_casse"}})
    assert r.status_code == 403
    (exports / "tbl_mort.json").symlink_to(exports / "disparu.json")  # lien interne cassé
    r = client.post(f"/api/connections/{c['id']}/preview", json={"table": {"name": "x", "id": "tbl_mort"}})
    assert r.status_code == 404 and "n'est plus publiée" in r.json()["detail"]
    alias = client.post(f"/api/connections/{c['id']}/preview", json={"table": {"name": "x", "id": "tbl_alias"}})
    assert alias.status_code == 200


# --- Atelier Projets ----------------------------------------------------------------------------------

DATASETS = [
    {"name": "work-items", "label": "Éléments de travail", "description": "Tâches, bugs…", "rowCount": 3},
    {"name": "time-entries", "label": "Temps passé", "description": "Saisies de temps", "rowCount": 2},
    {"name": "milestones", "label": "Jalons", "description": "Jalons des projets", "rowCount": 1},
]

WORK_ITEMS_COLUMNS = [
    {"key": "id", "label": "Identifiant", "type": "string"},
    {"key": "projet", "label": "Projet", "type": "string"},
    {"key": "statut", "label": "Statut", "type": "string"},
    {"key": "heures_estimees", "label": "Heures estimées", "type": "number"},
    {"key": "echeance", "label": "Échéance", "type": "date"},
    {"key": "maj_le", "label": "Mis à jour le", "type": "datetime"},
    {"key": "bloque", "label": "Bloqué", "type": "boolean"},
]


def work_items(project_id: str | None) -> list[dict[str, Any]]:
    rows = [
        {
            "id": "WI-1",
            "projet": "Atelier",
            "statut": "En cours",
            "heures_estimees": 8,
            "echeance": "2026-11-30",
            "maj_le": "2026-10-19T08:15:00.000Z",
            "bloque": False,
        },
        {
            "id": "WI-2",
            "projet": "Atelier",
            "statut": "Terminée",
            "heures_estimees": 3.5,
            "echeance": None,
            "maj_le": "2026-10-18T17:00:00.000Z",
            "bloque": True,
        },
        {
            "id": "WI-3",
            "projet": "Site",
            "statut": "À faire",
            "heures_estimees": None,
            "echeance": "2027-01-15",
            "maj_le": "2026-10-17T09:30:00+02:00",
            "bloque": None,
        },
    ]
    return [r for r in rows if project_id is None or (project_id == "p1") == (r["projet"] == "Atelier")]


class FakeProjets:
    """Atelier Projets simulé : enregistre les requêtes reçues."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.extra_rows: list[dict[str, Any]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if request.method != "GET":
            return httpx.Response(405)
        if path == "/api/health":
            return httpx.Response(200, json={"status": "ok", "database": "ok", "timestamp": "2026-10-19T10:00:00Z"})
        if path == "/api/projects":
            return httpx.Response(200, json=[{"id": "p1", "name": "Atelier"}, {"id": "p2", "name": "Site"}])
        if path == "/api/exports/datasets":
            return httpx.Response(200, json=DATASETS)
        if path == "/api/exports/datasets/work-items":
            rows = work_items(request.url.params.get("projectId")) + self.extra_rows
            return httpx.Response(
                200,
                json={
                    "name": "work-items",
                    "label": "Éléments de travail",
                    "generatedAt": "2026-10-19T10:00:00Z",
                    "columns": WORK_ITEMS_COLUMNS,
                    "rows": rows,
                },
            )
        return httpx.Response(404, json={"message": "Introuvable"})


@pytest.fixture
def projets(client: TestClient) -> FakeProjets:
    fake = FakeProjets()
    client.app.state.connections.projets_http_factory = lambda: httpx.Client(  # type: ignore[attr-defined]
        transport=httpx.MockTransport(fake)
    )
    return fake


def test_atelier_projets_lists_imports_and_refreshes(client: TestClient, projets: FakeProjets) -> None:
    infos = {c["kind"]: c for c in client.get("/api/connections/connectors").json()}
    assert infos["atelier_projets"]["default_location"] == "http://127.0.0.1:3000"

    c = make(client, name="Atelier Projets", kind="atelier_projets", base_url="http://127.0.0.1:3900/")
    assert "password" not in c and c["has_password"] is False
    test = client.post(f"/api/connections/{c['id']}/test").json()
    assert test["ok"] is True and "3 jeux" in test["message"] and test["server"] == "http://127.0.0.1:3900"

    listing = client.get(f"/api/connections/{c['id']}/tables").json()
    assert [(t["id"], t["name"], t["kind"], t["rows"]) for t in listing["tables"]] == [
        ("work-items", "Éléments de travail", "dataset", 3),
        ("time-entries", "Temps passé", "dataset", 2),
        ("milestones", "Jalons", "dataset", 1),
    ]
    assert listing["projects"] == [{"id": "p1", "name": "Atelier"}, {"id": "p2", "name": "Site"}]
    assert all(str(r.url).startswith("http://127.0.0.1:3900/api/") for r in projets.requests)

    table = listing["tables"][0]
    r = client.post(f"/api/connections/{c['id']}/import", json={"table": table, "project_id": "p1"})
    assert r.status_code == 201, r.text
    ds = r.json()
    assert ds["name"] == "Éléments de travail" and ds["format"] == "atelier_projets" and ds["rows"] == 2
    assert ds["origin"]["project_id"] == "p1" and ds["origin"]["table"]["id"] == "work-items"
    assert projets.requests[-1].url.params["projectId"] == "p1"
    types = {col["name"]: col["type"] for col in ds["columns"]}
    assert types == {
        "Identifiant": "string",
        "Projet": "string",
        "Statut": "string",
        "Heures estimées": "number",
        "Échéance": "date",
        "Mis à jour le": "date",
        "Bloqué": "boolean",
    }

    # Actualisation : même projet, nouvelles lignes.
    projets.extra_rows = [dict(work_items(None)[0], id="WI-4")]
    refreshed = client.post(f"/api/datasets/{ds['id']}/refresh").json()
    assert refreshed["rows"] == 3 and projets.requests[-1].url.params["projectId"] == "p1"

    # Tous les projets : pas de paramètre projectId.
    all_rows = client.post(f"/api/connections/{c['id']}/preview", json={"table": table}).json()
    assert len(all_rows["rows"]) == 4 and "projectId" not in projets.requests[-1].url.params


@pytest.fixture
def local_tz(monkeypatch: pytest.MonkeyPatch) -> Iterator[Callable[[str], None]]:
    """Force le fuseau local de la machine (variable `TZ`), puis rétablit l'original."""
    if not hasattr(time, "tzset"):
        pytest.skip("time.tzset n'existe pas sous Windows : fuseau de la machine non modifiable")

    def force(name: str) -> None:
        monkeypatch.setenv("TZ", name)
        time.tzset()

    yield force
    monkeypatch.undo()
    time.tzset()


def test_atelier_projets_types_are_kept(local_tz: Callable[[str], None]) -> None:
    local_tz("Europe/Paris")
    df = projets_frame(WORK_ITEMS_COLUMNS, work_items(None))
    assert df["Heures estimées"].tolist()[:2] == [8, 3.5]
    assert str(df["Bloqué"].dtype) == "boolean"
    assert str(df["Échéance"].iloc[0]) == "2026-11-30 00:00:00"
    # datetime avec fuseau → heure locale de la machine (Paris, heure d'été), sans fuseau
    assert str(df["Mis à jour le"].dtype) == "datetime64[ns]"
    assert [str(v) for v in df["Mis à jour le"]] == [
        "2026-10-19 10:15:00",
        "2026-10-18 19:00:00",
        "2026-10-17 09:30:00",
    ]
    # type inconnu → texte ; clés sans libellé → clé
    odd = projets_frame([{"key": "x", "type": "json"}, {"key": "y", "label": "", "type": "string"}], [{"x": {"a": 1}}])
    assert list(odd.columns) == ["x", "y"] and odd["x"].iloc[0] == '{"a": 1}'


def test_atelier_projets_datetimes_follow_the_machine_time_zone(local_tz: Callable[[str], None]) -> None:
    columns = [{"key": "t", "label": "Quand", "type": "datetime"}, {"key": "d", "label": "Jour", "type": "date"}]
    rows = [
        {"t": "2026-12-01T08:00:00Z", "d": "2026-12-01"},  # heure d'hiver
        {"t": "2026-07-01T08:00:00.000Z", "d": "2026-07-01"},  # heure d'été
        {"t": None, "d": None},
    ]
    local_tz("Europe/Paris")
    paris = projets_frame(columns, rows)
    assert [str(v) for v in paris["Quand"]] == ["2026-12-01 09:00:00", "2026-07-01 10:00:00", "NaT"]
    local_tz("America/New_York")
    ny = projets_frame(columns, rows)
    assert [str(v) for v in ny["Quand"]] == ["2026-12-01 03:00:00", "2026-07-01 04:00:00", "NaT"]
    # Les dates (AAAA-MM-JJ) ne bougent pas avec le fuseau.
    assert [str(v) for v in ny["Jour"]] == ["2026-12-01 00:00:00", "2026-07-01 00:00:00", "NaT"]
    local_tz("UTC")
    assert str(projets_frame(columns, rows)["Quand"].iloc[0]) == "2026-12-01 08:00:00"


def test_atelier_projets_not_running_is_explained(client: TestClient) -> None:
    def refuse(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("Connection refused", request=request)

    client.app.state.connections.projets_http_factory = lambda: httpx.Client(  # type: ignore[attr-defined]
        transport=httpx.MockTransport(refuse)
    )
    c = make(client, name="Atelier Projets", kind="atelier_projets")
    test = client.post(f"/api/connections/{c['id']}/test").json()
    assert test["ok"] is False and "injoignable" in test["message"] and "lancez-le" in test["message"]
    r = client.get(f"/api/connections/{c['id']}/tables")
    assert r.status_code == 503 and "Atelier Projets est injoignable à http://127.0.0.1:3000" in r.json()["detail"]


def test_atelier_projets_old_version_and_bad_answers(client: TestClient) -> None:
    def old(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/exports/datasets":
            return httpx.Response(404)
        return httpx.Response(200, text="pas du json")

    client.app.state.connections.projets_http_factory = lambda: httpx.Client(  # type: ignore[attr-defined]
        transport=httpx.MockTransport(old)
    )
    c = make(client, name="Atelier Projets", kind="atelier_projets")
    r = client.get(f"/api/connections/{c['id']}/tables")
    assert r.status_code == 404 and "mettez-le à jour" in r.json()["detail"]
    preview = client.post(f"/api/connections/{c['id']}/preview", json={"table": {"name": "x", "id": "x"}})
    assert preview.status_code == 502 and "JSON attendu" in preview.json()["detail"]
    assert client.post(f"/api/connections/{c['id']}/preview", json={}).status_code == 422


def test_atelier_projets_address_is_validated_and_local_only(client: TestClient, projets: FakeProjets) -> None:
    bad = client.post("/api/connections", json={"name": "x", "kind": "atelier_projets", "base_url": "ftp://srv"})
    assert bad.status_code == 422
    # Adresses locales acceptées à l'enregistrement…
    for url in ("http://127.0.0.1:3000", "http://localhost:3000", "http://[::1]:3000", "http://127.0.0.2:3000"):
        ok = client.post("/api/connections", json={"name": "ok", "kind": "atelier_projets", "base_url": url})
        assert ok.status_code == 201, url
    # … tout le reste refusé, même en mode « En ligne » (réseau privé, Internet, IP déguisée, métadonnées cloud).
    client.put("/api/settings", json={"online_mode": True})
    for url in (
        "http://192.168.1.20:3000",
        "http://10.0.0.5:3000",
        "http://169.254.169.254/latest",
        "http://projets.example.com",
        "http://127.0.0.1.nip.io:3000",
        "http://0.0.0.0:3000",
        "http://[::ffff:10.0.0.1]:3000",
    ):
        r = client.post("/api/connections", json={"name": "x", "kind": "atelier_projets", "base_url": url})
        assert r.status_code == 422, url
        assert "n'est pas une adresse locale" in r.text and "127.0.0.1, localhost ou ::1" in r.text
        r = client.post("/api/connections/test", json={"name": "x", "kind": "atelier_projets", "base_url": url})
        assert r.status_code == 422, url
    assert projets.requests == []  # rien n'est parti


def write_registry(client: TestClient, base_url: str) -> str:
    """Connexion enregistrée par une version antérieure (adresse non vérifiée à l'époque)."""
    service = client.app.state.connections  # type: ignore[attr-defined]
    service.path.write_text(
        json.dumps(
            [
                {
                    "id": "ancienne",
                    "name": "Ancienne",
                    "kind": "atelier_projets",
                    "base_url": base_url,
                    "created_at": "2026-10-01T00:00:00Z",
                }
            ]
        ),
        encoding="utf-8",
    )
    return "ancienne"


@pytest.mark.parametrize("online", [False, True])
def test_atelier_projets_saved_remote_address_is_refused_in_both_modes(
    client: TestClient, projets: FakeProjets, monkeypatch: pytest.MonkeyPatch, online: bool
) -> None:
    import socket

    resolved: list[str] = []

    def fake(host: str, *_: object, **__: object) -> list[tuple[Any, ...]]:
        resolved.append(host)
        return [(socket.AF_INET, 0, 0, "", ("10.0.0.7", 0))]

    monkeypatch.setattr(socket, "getaddrinfo", fake)
    client.put("/api/settings", json={"online_mode": online})
    cid = write_registry(client, "http://projets.corp:3000")
    r = client.get(f"/api/connections/{cid}/tables")
    assert r.status_code == 403 and "n'est pas une adresse locale" in r.json()["detail"]
    assert client.post(f"/api/connections/{cid}/test").status_code == 403
    imp = client.post(f"/api/connections/{cid}/import", json={"table": {"name": "w", "id": "work-items"}})
    assert imp.status_code == 403
    assert projets.requests == [] and resolved == []  # nom distant refusé sans même le résoudre


def test_atelier_projets_localhost_must_resolve_to_loopback(
    client: TestClient, projets: FakeProjets, monkeypatch: pytest.MonkeyPatch
) -> None:
    import socket

    answers: dict[str, list[str]] = {"localhost": ["127.0.0.1", "::1"]}

    def fake(host: str, *_: object, **__: object) -> list[tuple[Any, ...]]:
        return [(socket.AF_INET, 0, 0, "", (a, 0)) for a in answers[host]]

    monkeypatch.setattr(socket, "getaddrinfo", fake)
    c = make(client, name="Local", kind="atelier_projets", base_url="http://localhost:3900")
    assert client.get(f"/api/connections/{c['id']}/tables").status_code == 200
    # Fichier hosts détourné : localhost pointe ailleurs → refus, rien n'est envoyé.
    answers["localhost"] = ["127.0.0.1", "192.168.1.9"]
    sent = len(projets.requests)
    r = client.get(f"/api/connections/{c['id']}/tables")
    assert r.status_code == 403 and "n'est pas une adresse locale" in r.json()["detail"]
    assert len(projets.requests) == sent


def test_atelier_projets_redirects_are_not_followed(client: TestClient) -> None:
    seen: list[str] = []

    def redirect(request: httpx.Request) -> httpx.Response:
        seen.append(str(request.url))
        if request.url.host == "127.0.0.1":
            return httpx.Response(302, headers={"Location": "http://169.254.169.254/latest/meta-data"})
        return httpx.Response(200, json=DATASETS)

    # Même un client configuré pour suivre les redirections ne doit pas les suivre.
    client.app.state.connections.projets_http_factory = lambda: httpx.Client(  # type: ignore[attr-defined]
        transport=httpx.MockTransport(redirect), follow_redirects=True
    )
    c = make(client, name="Atelier Projets", kind="atelier_projets")
    r = client.get(f"/api/connections/{c['id']}/tables")
    assert r.status_code == 502 and "redirection" in r.json()["detail"] and "n'est pas suivie" in r.json()["detail"]
    assert seen == ["http://127.0.0.1:3000/api/exports/datasets"]


def test_default_projets_client_does_not_follow_redirects(client: TestClient) -> None:
    http = client.app.state.connections.projets_http_factory()  # type: ignore[attr-defined]
    with http:
        assert http.follow_redirects is False and http._trust_env is False
