"""Lecture et typage des fichiers importés."""

import io
import json
from pathlib import Path

import pandas as pd
import pytest

from app.services.data import DatasetError, build_profile, read_table, records

SAMPLE = Path(__file__).resolve().parents[2] / "samples" / "ventes_2026.csv"


def types(df: pd.DataFrame) -> dict[str, str]:
    return {c.name: c.type for c in build_profile(df)}


def test_french_csv_semicolon_comma_decimal_dates_percent_bool() -> None:
    content = (
        "date;région;montant;taux;actif\n05/01/2026;Nord;1 234,50;19,5 %;oui\n31/01/2026;Sud;980,00;22 %;non\n"
    ).encode("cp1252")
    df, fmt = read_table("ventes.csv", content)

    assert fmt == "csv"
    assert types(df) == {"date": "date", "région": "string", "montant": "number", "taux": "number", "actif": "boolean"}
    assert df["montant"].tolist() == [1234.5, 980.0]
    assert df["taux"].tolist() == [19.5, 22.0]
    assert df["date"].iloc[1] == pd.Timestamp("2026-01-31")  # jour en premier


def test_english_csv_thousands_comma_and_iso_dates() -> None:
    content = b'day,city,revenue\n2026-03-01,Paris,"1,250.75"\n2026-03-02,Lyon,980.10\n'
    df, _ = read_table("data.csv", content)
    assert types(df) == {"day": "date", "city": "string", "revenue": "number"}
    assert df["revenue"].tolist() == [1250.75, 980.10]
    assert df["day"].iloc[0] == pd.Timestamp("2026-03-01")


def test_mostly_text_column_stays_string() -> None:
    df, _ = read_table("x.csv", b"code\nA1\n12\nB7\n")
    assert types(df) == {"code": "string"}


def test_xlsx() -> None:
    buffer = io.BytesIO()
    pd.DataFrame({"mois": ["Jan", "Fév"], "ventes": [42.3, 38.9]}).to_excel(buffer, index=False)
    df, fmt = read_table("rapport.xlsx", buffer.getvalue())
    assert fmt == "xlsx"
    assert types(df) == {"mois": "string", "ventes": "number"}


def test_json_records_nested_under_key() -> None:
    payload = {"data": [{"a": 1, "b": {"c": "x"}}, {"a": 2, "b": {"c": "y"}}]}
    df, fmt = read_table("d.json", json.dumps(payload).encode())
    assert fmt == "json"
    assert list(df.columns) == ["a", "b.c"]


def test_duplicate_and_blank_headers_are_renamed() -> None:
    df, _ = read_table("x.csv", b"a;a;\n1;2;3\n")
    assert list(df.columns) == ["a", "a_2", "colonne_3"]


@pytest.mark.parametrize(
    ("name", "content", "message"),
    [
        ("x.pdf", b"%PDF", "non pris en charge"),
        ("x.csv", b"   ", "vide"),
        ("x.json", b'{"a": 1}', "liste"),
    ],
)
def test_invalid_files(name: str, content: bytes, message: str) -> None:
    with pytest.raises(DatasetError, match=message):
        read_table(name, content)


def test_records_are_json_safe() -> None:
    df = pd.DataFrame({"d": pd.to_datetime(["2026-01-05", None]), "n": [1.5, float("nan")]})
    assert records(df) == [{"d": "2026-01-05", "n": 1.5}, {"d": None, "n": None}]


def test_sample_file_is_fully_typed() -> None:
    df, _ = read_table(SAMPLE.name, SAMPLE.read_bytes())
    assert types(df) == {
        "date": "date",
        "region": "string",
        "produit": "string",
        "quantite": "number",
        "prix_unitaire": "number",
        "chiffre_affaires": "number",
        "taux_marge": "number",
        "client_nouveau": "boolean",
    }
