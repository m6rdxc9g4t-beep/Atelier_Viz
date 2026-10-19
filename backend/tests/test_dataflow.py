"""Import d'une enveloppe DataFlow v2.1.0 d'Atelier Tab (docs/SUITE.md §4.2) : aplatissement et types."""

import json
from pathlib import Path

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.services.data.dataflow import DataflowError, dataflow_frame, dataflow_info, is_dataflow, is_error
from app.services.data.parsing import DatasetError, read_table

FIXTURES = Path(__file__).parent / "fixtures"


def load(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def test_recognises_the_envelope_only() -> None:
    assert is_dataflow(load("dataflow_planning.json"))
    assert not is_dataflow([{"a": 1}])
    assert not is_dataflow({"data": [{"a": 1}]})
    assert not is_dataflow({"target_system": "x", "schema_version": "2.1.0", "project": {}})
    assert is_error("#DIV/0!") and is_error("#NAME?") and is_error("#N/A")
    assert not is_error("#1 du classement") and not is_error(0)


def test_error_codes_are_a_closed_list() -> None:
    """Seuls les 8 codes d'Atelier Tab sont des erreurs : un texte « #URGENT! » est conservé."""
    for code in ("#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#NUM!", "#N/A", "#CYCLE!", "#ERROR!"):
        assert is_error(code)
    for text in ("#URGENT!", "#TODO?", "#A1!", "#ref!", "#N/A ", "#DIV/0"):
        assert not is_error(text)
    envelope = {
        "target_system": "atelier",
        "schema_version": "2.1.0",
        "project": {
            "name": "P",
            "columns_schema": [{"col_letter": "A", "label": "Note", "type": "text"}],
            "records": [
                {"row_index": 0, "record_id": "r1", "values": {"A": {"computed": "#URGENT!"}}},
                {"row_index": 1, "record_id": "r2", "values": {"A": {"computed": "#REF!"}}},
            ],
        },
    }
    assert dataflow_frame(envelope)["Note"].tolist() == ["#URGENT!", None]


def test_flattens_the_specification_example() -> None:
    df = dataflow_frame(load("dataflow_planning.json"))
    assert list(df.columns) == [
        "_ligne",
        "_id",
        "Lot / Tâche",
        "Statut",
        "Coût HT",
        "Coût TTC",
        "Responsable",
        "Échéance",
    ]
    assert len(df) == 3  # la ligne de total (summary_rows) n'est pas importée
    assert df["_ligne"].tolist() == [1, 2, 3] and df["_id"].tolist() == ["rec_01", "rec_02", "rec_03"]
    assert df["Coût HT"].sum() == 88500 and df["Coût TTC"].sum() == 106200  # valeurs `computed`, pas `raw`
    assert pd.api.types.is_numeric_dtype(df["Coût TTC"])  # formule numérique → nombre
    assert pd.api.types.is_datetime64_any_dtype(df["Échéance"])
    assert df["Échéance"].iloc[0] == pd.Timestamp("2026-11-30")
    assert df["Statut"].tolist() == ["En cours", "Terminé", "À faire"]

    info = dataflow_info(load("dataflow_planning.json"))
    assert (info.table_id, info.table_name, info.project_name, info.rows) == (
        "tbl_planning_lots",
        "Planning & Lots",
        "Rénovation Urbaine 2026",
        3,
    )


def test_types_errors_and_codes() -> None:
    df = dataflow_frame(load("dataflow_materiaux.json"))
    assert str(df["Commandé"].dtype) == "boolean"
    assert df["Commandé"].tolist()[:2] == [True, False] and pd.isna(df["Commandé"].iloc[2])
    # Erreur de formule → vide ; la colonne reste numérique.
    assert pd.api.types.is_numeric_dtype(df["Total HT"]) and pd.isna(df["Total HT"].iloc[1])
    assert pd.isna(df["Prix unitaire"].iloc[1])  # cellule vide d'une colonne monétaire
    assert df["TVA"].tolist() == [0.2, 0.2, 0.055]  # pourcentage → nombre (fraction)
    # Texte gardé tel quel (zéros en tête) : aucune réinterprétation.
    assert df["Référence"].tolist()[:2] == ["00123", "00456"]


def test_formula_with_text_results_stays_text() -> None:
    data = load("dataflow_planning.json")
    data["project"]["columns_schema"][3]["type"] = "formula"
    for i, rec in enumerate(data["project"]["records"]):
        rec["values"]["D"]["computed"] = f"Lot {i}"
    assert dataflow_frame(data)["Coût TTC"].tolist() == ["Lot 0", "Lot 1", "Lot 2"]


def test_duplicate_labels_and_missing_cells() -> None:
    data = load("dataflow_planning.json")
    data["project"]["columns_schema"][1]["label"] = "Lot / Tâche"
    data["project"]["columns_schema"][4]["label"] = ""
    del data["project"]["records"][0]["values"]["C"]
    df = dataflow_frame(data)
    assert list(df.columns)[2:5] == ["Lot / Tâche", "Lot / Tâche_2", "Coût HT"]
    assert "E" in df.columns  # libellé vide → lettre de colonne
    assert pd.isna(df["Coût HT"].iloc[0])


def test_invalid_envelopes_are_explained() -> None:
    data = load("dataflow_planning.json")
    data["project"]["columns_schema"] = []
    with pytest.raises(DataflowError, match="sans colonne"):
        dataflow_frame(data)
    empty = load("dataflow_planning.json")
    empty["project"]["records"] = []
    with pytest.raises(DatasetError, match="aucune ligne"):
        read_table("vide.json", json.dumps(empty).encode())


def test_read_table_keeps_plain_json_behaviour() -> None:
    df, fmt = read_table("x.json", b'[{"code": "01000", "ca": "12,5"}]')
    assert fmt == "json" and df["code"].tolist() == ["01000"] and df["ca"].tolist() == [12.5]


def test_upload_of_a_snapshot_over_api(client: TestClient) -> None:
    content = (FIXTURES / "dataflow_planning.json").read_bytes()
    r = client.post("/api/datasets", files={"file": ("tbl_planning_lots.json", content, "application/json")})
    assert r.status_code == 201, r.text
    ds = r.json()
    assert ds["rows"] == 3 and ds["format"] == "json"
    types = {c["name"]: c["type"] for c in ds["columns"]}
    assert types == {
        "_ligne": "number",
        "_id": "string",
        "Lot / Tâche": "string",
        "Statut": "string",
        "Coût HT": "number",
        "Coût TTC": "number",
        "Responsable": "string",
        "Échéance": "date",
    }
    total = client.post(
        "/api/query", json={"dataset_id": ds["id"], "measures": [{"field": "Coût TTC", "agg": "sum"}]}
    ).json()
    assert total["rows"][0][0] == 106200
