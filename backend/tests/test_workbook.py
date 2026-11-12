"""Classeurs Excel à plusieurs feuilles : examen, import d'un jeu par feuille, remplacement feuille par feuille."""

import io
from datetime import UTC, datetime
from pathlib import Path

import pandas as pd
import pytest
from fastapi.testclient import TestClient
from openpyxl import Workbook
from openpyxl.chart import BarChart, Reference

from app.services.data.parsing import (
    DatasetError,
    is_workbook,
    read_sheets,
    sheet_dataset_name,
    sheet_dataset_names,
)

XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def workbook(sheets: dict[str, list[list[object]]], *, chart: str | None = None) -> bytes:
    """Classeur en mémoire : une feuille par entrée, ses lignes telles quelles (`chart` : feuille de graphique)."""
    wb = Workbook()
    wb.remove(wb.active)  # type: ignore[arg-type]
    for name, rows in sheets.items():
        ws = wb.create_sheet()
        # openpyxl renomme un titre qui ressemble à un autre (« données2 ») : le titre demandé est imposé tel quel,
        # comme dans un fichier produit par un autre outil, où deux feuilles ne diffèrent que par la casse.
        ws._WorkbookChild__title = name  # type: ignore[attr-defined]
        for row in rows:
            ws.append(row)
    if chart:
        bars = BarChart()
        bars.add_data(Reference(wb.worksheets[0], min_col=3, min_row=1, max_row=4), titles_from_data=True)
        wb.create_chartsheet(chart).add_chart(bars)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


VENTES = [["Mois", "Région", "Montant"], ["2026-01", "Nord", 1200.5], ["2026-02", "Sud", 800], ["2026-03", "Nord", 950]]
OBJECTIFS = [["Région", "Objectif"], ["Nord", 3000], ["Sud", 2500]]
THREE = {"Ventes": VENTES, "Notes": [], "Objectifs été": OBJECTIFS}


def send(
    client: TestClient, path: str, content: bytes, name: str = "Budget 2026.xlsx", sheets: list[str] | None = None
):
    data = {"sheets": sheets} if sheets is not None else None
    return client.post(path, files={"file": (name, content, XLSX)}, data=data)


# ─── Lecture ─────────────────────────────────────────────────────────────────────────────────────────────


def test_read_sheets_reads_every_sheet_and_reports_the_empty_one() -> None:
    read = read_sheets(workbook(THREE))
    assert [s.name for s in read] == ["Ventes", "Notes", "Objectifs été"]
    ventes, notes, objectifs = read
    assert ventes.error is None and ventes.df is not None
    assert list(ventes.df.columns) == ["Mois", "Région", "Montant"] and len(ventes.df) == 3
    assert pd.api.types.is_numeric_dtype(ventes.df["Montant"])
    assert notes.df is None and notes.error == "Feuille vide : aucune donnée à importer."
    assert objectifs.df is not None and list(objectifs.df["Objectif"]) == [3000, 2500]


def test_read_sheets_only_keeps_workbook_order_and_reports_a_missing_sheet() -> None:
    read = read_sheets(workbook(THREE), ["Objectifs été", "Ventes", "Inconnue"])
    assert [(s.name, s.error) for s in read] == [
        ("Ventes", None),
        ("Objectifs été", None),
        ("Inconnue", "Feuille absente du classeur."),
    ]


def test_a_chart_sheet_is_not_a_table_and_does_not_block_the_others() -> None:
    # Feuille de graphique : aucune cellule ; elle n'est pas proposée, les feuilles de données sont lues.
    read = read_sheets(workbook({"Ventes": VENTES, "Objectifs": OBJECTIFS}, chart="Graphique"))
    assert [(s.name, s.error) for s in read] == [("Ventes", None), ("Objectifs", None)]


def test_an_unreadable_sheet_does_not_block_the_others(monkeypatch: pytest.MonkeyPatch) -> None:
    real = pd.read_excel

    def flaky(book: object, *args: object, sheet_name: object = 0, **kwargs: object) -> pd.DataFrame:
        if sheet_name == "Cassée":
            raise ValueError("cellule fusionnée hors limites")
        return real(book, *args, sheet_name=sheet_name, **kwargs)  # type: ignore[call-overload, no-any-return]

    monkeypatch.setattr(pd, "read_excel", flaky)
    read = read_sheets(workbook({"Ventes": VENTES, "Cassée": OBJECTIFS, "Objectifs": OBJECTIFS}))
    by_name = {s.name: s for s in read}
    assert by_name["Ventes"].df is not None and by_name["Objectifs"].df is not None
    assert by_name["Cassée"].df is None
    assert by_name["Cassée"].error == "Feuille illisible : cellule fusionnée hors limites"


def test_sheet_with_title_rows_above_the_table_is_read_like_a_single_file() -> None:
    rows = [["Rapport des ventes 2026"], [], *VENTES]
    read = read_sheets(workbook({"Synthèse": rows}))
    assert read[0].df is not None and list(read[0].df.columns) == ["Mois", "Région", "Montant"]


def test_unreadable_workbook_and_empty_file() -> None:
    with pytest.raises(DatasetError, match="Classeur Excel illisible"):
        read_sheets(b"pas un classeur")
    with pytest.raises(DatasetError, match="vide"):
        read_sheets(b"  ")


def test_names() -> None:
    assert is_workbook("Budget.XLSX") and not is_workbook("ventes.csv") and not is_workbook("données.json")
    assert sheet_dataset_name("Budget 2026.xlsx", "Objectifs été") == "Budget 2026 — Objectifs été"
    assert sheet_dataset_name("dossier/Suivi.v2.xlsx", " Août ") == "Suivi.v2 — Août"
    # Noms distincts dans un même classeur, dans l'ordre des feuilles.
    assert sheet_dataset_names("A.xlsx", ["X", "x", "X ", " X"]) == ["A — X", "A — x", "A — X (2)", "A — X (3)"]


# ─── Examen avant import ─────────────────────────────────────────────────────────────────────────────────


def test_inspect_lists_every_sheet_without_storing_anything(client: TestClient) -> None:
    response = send(client, "/api/datasets/sheets", workbook(THREE))
    assert response.status_code == 200
    body = response.json()
    assert body["filename"] == "Budget 2026.xlsx"
    assert body["sheets"] == [
        {
            "name": "Ventes",
            "dataset_name": "Budget 2026 — Ventes",
            "rows": 3,
            "columns": ["Mois", "Région", "Montant"],
            "error": None,
        },
        {
            "name": "Notes",
            "dataset_name": "Budget 2026 — Notes",
            "rows": 0,
            "columns": [],
            "error": "Feuille vide : aucune donnée à importer.",
        },
        {
            "name": "Objectifs été",
            "dataset_name": "Budget 2026 — Objectifs été",
            "rows": 2,
            "columns": ["Région", "Objectif"],
            "error": None,
        },
    ]
    assert client.get("/api/datasets").json() == []


def test_inspect_a_file_that_is_not_a_workbook_has_no_sheets(client: TestClient) -> None:
    response = client.post("/api/datasets/sheets", files={"file": ("ventes.csv", b"a;b\n1;2\n", "text/csv")})
    assert response.status_code == 200 and response.json() == {"filename": "ventes.csv", "sheets": []}


def test_inspect_refuses_a_broken_workbook(client: TestClient) -> None:
    response = send(client, "/api/datasets/sheets", b"pas un classeur")
    assert response.status_code == 422 and "Classeur Excel illisible" in response.json()["detail"]


# ─── Import ──────────────────────────────────────────────────────────────────────────────────────────────


def test_import_creates_one_dataset_per_sheet_and_sets_the_empty_one_aside(client: TestClient) -> None:
    response = send(client, "/api/datasets/workbook", workbook(THREE))
    assert response.status_code == 201
    body = response.json()
    assert [(d["name"], d["sheet"], d["rows"], d["format"]) for d in body["datasets"]] == [
        ("Budget 2026 — Ventes", "Ventes", 3, "xlsx"),
        ("Budget 2026 — Objectifs été", "Objectifs été", 2, "xlsx"),
    ]
    assert body["skipped"] == [{"name": "Notes", "reason": "Feuille vide : aucune donnée à importer."}]
    # Jeux enregistrés, distincts, chacun avec ses colonnes et sa feuille.
    # La liste des jeux (le plus récent d'abord) suit l'ordre des feuilles du classeur.
    assert [d["name"] for d in client.get("/api/datasets").json()] == [
        "Budget 2026 — Ventes",
        "Budget 2026 — Objectifs été",
    ]
    listed = {d["name"]: d for d in client.get("/api/datasets").json()}
    assert listed["Budget 2026 — Objectifs été"]["sheet"] == "Objectifs été"
    objectifs = client.get(f"/api/datasets/{listed['Budget 2026 — Objectifs été']['id']}").json()
    assert [c["name"] for c in objectifs["columns"]] == ["Région", "Objectif"]
    assert objectifs["origin"] is None


def test_import_only_the_checked_sheets(client: TestClient) -> None:
    response = send(client, "/api/datasets/workbook", workbook(THREE), sheets=["Objectifs été"])
    assert response.status_code == 201
    body = response.json()
    assert [d["name"] for d in body["datasets"]] == ["Budget 2026 — Objectifs été"] and body["skipped"] == []
    assert len(client.get("/api/datasets").json()) == 1


def test_sheet_names_that_look_alike_or_carry_accents_each_get_their_dataset(client: TestClient) -> None:
    # « Données » et « données » (casse), « Données » avec une espace finale, et un nom accentué avec apostrophe.
    sheets = {
        "Données": [["a"], [1]],
        "données": [["b"], [2], [3]],
        "Données ": [["c"], [4], [5], [6]],
        "Été — coût d'achat": [["d"], [7]],
    }
    response = send(client, "/api/datasets/workbook", workbook(sheets), name="Année.xlsx")
    assert response.status_code == 201
    datasets = response.json()["datasets"]
    assert [d["sheet"] for d in datasets] == list(sheets)
    # Noms tous distincts : la feuille à l'espace finale donnerait le même nom que la première, elle est numérotée.
    names = [d["name"] for d in datasets]
    assert names == ["Année — Données", "Année — données", "Année — Données (2)", "Année — Été — coût d'achat"]
    assert len({d["id"] for d in datasets}) == 4
    # Chaque jeu porte bien les données de sa propre feuille.
    assert [[c["name"] for c in d["columns"]] for d in datasets] == [["a"], ["b"], ["c"], ["d"]]
    assert [d["rows"] for d in datasets] == [1, 2, 3, 1]


def test_importing_the_same_workbook_twice_numbers_the_new_datasets(client: TestClient) -> None:
    content = workbook({"Ventes": VENTES, "Objectifs": OBJECTIFS})
    send(client, "/api/datasets/workbook", content)
    again = send(client, "/api/datasets/workbook", content).json()
    assert [d["name"] for d in again["datasets"]] == ["Budget 2026 — Ventes (2)", "Budget 2026 — Objectifs (2)"]


def test_import_with_nothing_to_import_is_refused_and_says_why(client: TestClient) -> None:
    response = send(client, "/api/datasets/workbook", workbook({"Notes": [], "Brouillon": []}))
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert "Aucune feuille à importer" in detail and "« Notes »" in detail and "« Brouillon »" in detail
    assert client.get("/api/datasets").json() == []
    # Feuille demandée absente du classeur : rien d'importé, raison donnée.
    missing = send(client, "/api/datasets/workbook", workbook(THREE), sheets=["Inconnue"])
    assert missing.status_code == 422 and "Feuille absente du classeur" in missing.json()["detail"]
    # Un CSV n'a pas de feuilles.
    csv = client.post("/api/datasets/workbook", files={"file": ("ventes.csv", b"a;b\n1;2\n", "text/csv")})
    assert csv.status_code == 422 and "classeur Excel" in csv.json()["detail"]


def test_a_single_sheet_workbook_still_imports_as_before(client: TestClient) -> None:
    content = workbook({"Feuil1": VENTES})
    # L'import habituel ne change pas : nom du fichier, première feuille, pas de feuille retenue.
    plain = client.post("/api/datasets", files={"file": ("ventes.xlsx", content, XLSX)})
    assert plain.status_code == 201
    assert plain.json()["name"] == "ventes.xlsx" and plain.json()["sheet"] is None and plain.json()["rows"] == 3
    # L'examen n'y voit qu'une feuille : l'interface n'affiche alors aucun choix.
    assert len(send(client, "/api/datasets/sheets", content, name="ventes.xlsx").json()["sheets"]) == 1
    # Un classeur à plusieurs feuilles envoyé à l'import habituel : première feuille, comme avant.
    first = client.post("/api/datasets", files={"file": ("budget.xlsx", workbook(THREE), XLSX)}).json()
    assert first["name"] == "budget.xlsx" and [c["name"] for c in first["columns"]] == ["Mois", "Région", "Montant"]


# ─── Remplacement des données : la bonne feuille est relue ───────────────────────────────────────────────


def test_replacing_the_data_reads_the_sheet_the_dataset_came_from(client: TestClient) -> None:
    created = send(client, "/api/datasets/workbook", workbook(THREE)).json()["datasets"]
    objectifs = next(d for d in created if d["sheet"] == "Objectifs été")
    # Nouveau classeur : les feuilles ont changé d'ordre et de contenu ; « Objectifs été » n'est plus la première.
    updated = workbook({"Notes": [["x"], [1]], "Objectifs été": [*OBJECTIFS, ["Est", 1800]], "Ventes": VENTES})
    response = client.put(f"/api/datasets/{objectifs['id']}/data", files={"file": ("Budget 2026.xlsx", updated, XLSX)})
    assert response.status_code == 200
    body = response.json()
    assert body["rows"] == 3 and [c["name"] for c in body["columns"]] == ["Région", "Objectif"]
    assert body["sheet"] == "Objectifs été" and body["name"] == "Budget 2026 — Objectifs été"


def test_replacing_with_a_one_sheet_extract_or_a_csv_works(client: TestClient) -> None:
    created = send(client, "/api/datasets/workbook", workbook(THREE)).json()["datasets"]
    objectifs = next(d for d in created if d["sheet"] == "Objectifs été")
    url = f"/api/datasets/{objectifs['id']}/data"
    # La feuille enregistrée à part, sous un autre nom de feuille : la seule feuille du classeur est lue.
    alone = workbook({"Feuil1": [*OBJECTIFS, ["Est", 1800], ["Ouest", 900]]})
    assert client.put(url, files={"file": ("extrait.xlsx", alone, XLSX)}).json()["rows"] == 4
    # Un CSV : pas de feuille à chercher.
    csv = "Région;Objectif\nNord;1\n".encode()
    assert client.put(url, files={"file": ("objectifs.csv", csv, "text/csv")}).json()["rows"] == 1


def test_replacing_with_a_workbook_that_lost_the_sheet_changes_nothing(client: TestClient) -> None:
    created = send(client, "/api/datasets/workbook", workbook(THREE)).json()["datasets"]
    objectifs = next(d for d in created if d["sheet"] == "Objectifs été")
    other = workbook({"Ventes": VENTES, "Synthèse": OBJECTIFS})
    response = client.put(f"/api/datasets/{objectifs['id']}/data", files={"file": ("autre.xlsx", other, XLSX)})
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert "feuille « Objectifs été »" in detail and "« Ventes », « Synthèse »" in detail
    assert client.get(f"/api/datasets/{objectifs['id']}").json()["rows"] == 2


# ─── Connexion vers un classeur : chaque feuille importée garde sa feuille, l'actualisation relit la bonne ──


def test_every_sheet_of_a_synced_workbook_becomes_a_dataset_that_refreshes_from_its_own_sheet(
    client: TestClient, tmp_path: Path
) -> None:
    path = tmp_path / "Budget 2026.xlsx"
    path.write_bytes(workbook(THREE))
    created = client.post("/api/connections", json={"name": "Budget", "kind": "file", "path": str(path)})
    assert created.status_code == 201
    cid = created.json()["id"]
    listed = client.get(f"/api/connections/{cid}/tables").json()["tables"]
    assert [t["name"] for t in listed] == ["Ventes", "Notes", "Objectifs été"]
    # Une demande d'import par feuille, comme le fait l'interface (« Importer plusieurs feuilles… »).
    results = {t["name"]: client.post(f"/api/connections/{cid}/import", json={"table": t}) for t in listed}
    assert results["Notes"].status_code == 422 and "Aucune donnée exploitable" in results["Notes"].json()["detail"]
    ventes, objectifs = results["Ventes"].json(), results["Objectifs été"].json()
    assert (ventes["name"], objectifs["name"]) == ("Budget 2026 — Ventes", "Budget 2026 — Objectifs été")
    assert objectifs["origin"]["table"] == {**objectifs["origin"]["table"], "name": "Objectifs été", "kind": "sheet"}
    # Le classeur change (ordre des feuilles compris) : chaque jeu relit sa propre feuille.
    path.write_bytes(workbook({"Objectifs été": [*OBJECTIFS, ["Est", 1800]], "Ventes": VENTES[:3]}))
    assert client.post(f"/api/datasets/{objectifs['id']}/refresh").json()["rows"] == 3
    refreshed = client.post(f"/api/datasets/{ventes['id']}/refresh").json()
    assert refreshed["rows"] == 2 and [c["name"] for c in refreshed["columns"]] == ["Mois", "Région", "Montant"]


def test_datasets_created_at_the_same_instant_are_listed_last_created_first(client: TestClient) -> None:
    # Horloge peu fine (Windows) : deux jeux créés à la même date gardent un ordre stable, le dernier créé d'abord.
    store = client.app.state.dataset_store  # type: ignore[attr-defined]
    for name in ("premier", "deuxième", "troisième"):
        store.add(name, "csv", pd.DataFrame({"a": [1]}))
    store.db.execute("UPDATE __datasets SET created_at = ?", [datetime(2026, 11, 12, tzinfo=UTC)])
    assert [d.name for d in store.list()] == ["troisième", "deuxième", "premier"]
