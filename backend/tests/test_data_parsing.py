"""Lecture et typage des fichiers importés."""

import io
import json
from collections.abc import Callable
from pathlib import Path

import pandas as pd
import pytest

from app.services.data import DatasetError, build_profile, parsing, read_table, records
from app.services.data.parsing import decimal_separator, header_row

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


def numbers(*values: str) -> list:
    """Colonne « montant » d'un CSV à point-virgule, telle que l'import la type."""
    content = "nom;montant\n" + "".join(f"L{i};{v}\n" for i, v in enumerate(values))
    return read_table("x.csv", content.encode())[0]["montant"].tolist()


def test_european_numbers_with_dot_thousands() -> None:
    # Le point des milliers ne doit pas faire prendre la virgule décimale pour un séparateur de milliers.
    assert numbers("1.234,56", "12,50", "980,00") == [1234.56, 12.5, 980.0]
    assert numbers("1.234.567", "12.000") == [1234567.0, 12000.0]


def test_english_numbers_with_integer_thousands() -> None:
    # « 12,000 » au milieu d'une colonne anglaise : douze mille, pas douze.
    assert numbers("1,234.50", "980.00", "12,000", "3,456.78") == [1234.5, 980.0, 12000.0, 3456.78]
    assert numbers("1,234,567", "12,000") == [1234567.0, 12000.0]


def test_contradictory_separators_stay_text() -> None:
    # Les deux conventions dans la même colonne : du texte (visible) plutôt qu'un nombre faux.
    assert numbers("1,5", "2.5", "3,25") == ["1,5", "2.5", "3,25"]


def test_ambiguous_numbers_keep_the_french_reading() -> None:
    assert numbers("1,234", "12,000", "950") == [1.234, 12.0, 950.0]
    assert numbers("1.234", "12.000") == [1.234, 12.0]


def test_currency_amounts_and_typographic_minus_are_numbers() -> None:
    # Excel en français enregistre les cellules monétaires telles qu'affichées : « 1 234,56 € » (espaces insécables).
    assert numbers("1\u202f234,56\u00a0€", "12,50 €", "-8,30 €") == [1234.56, 12.5, -8.3]
    assert numbers("$1,234.50", "$980.00", "-$12.00") == [1234.5, 980.0, -12.0]
    assert numbers("£ 10.50", "£3") == [10.5, 3.0]
    assert numbers("\u221212,50", "8,30") == [-12.5, 8.3]  # signe moins typographique (U+2212)
    # Deux devises dans la colonne : on ne les additionne pas, elle reste du texte.
    assert numbers("12,50 €", "$8.30") == ["12,50 €", "$8.30"]
    # Un symbole au milieu d'une valeur n'est pas un montant.
    assert numbers("12€50", "3€20") == ["12€50", "3€20"]


@pytest.mark.parametrize(
    ("values", "expected"),
    [
        (["1.234,56", "12,50"], ","),  # les deux séparateurs : le dernier est la décimale
        (["1,234.50", "12,000"], "."),
        (["1,5", "2"], ","),  # 1 ou 2 chiffres après le séparateur : une décimale
        (["0.25", "12,000"], "."),
        (["1,234,567"], "."),  # séparateur répété : des milliers
        (["1.234.567"], ","),
        (["1,234", "950"], ","),  # aucun indice : lecture française
        (["1234", "12"], "."),
        (["1,5", "2.5"], None),  # indices contradictoires
        (["1,234,567", "12,5"], None),
    ],
)
def test_decimal_separator(values: list[str], expected: str | None) -> None:
    assert decimal_separator(pd.Series(values, dtype="string")) == expected


def test_mostly_text_column_stays_string() -> None:
    df, _ = read_table("x.csv", b"code\nA1\n12\nB7\n")
    assert types(df) == {"code": "string"}


def test_xlsx() -> None:
    buffer = io.BytesIO()
    pd.DataFrame({"mois": ["Jan", "Fév"], "ventes": [42.3, 38.9]}).to_excel(buffer, index=False)
    df, fmt = read_table("rapport.xlsx", buffer.getvalue())
    assert fmt == "xlsx"
    assert types(df) == {"mois": "string", "ventes": "number"}


def test_xlsx_text_cells_keep_their_leading_zeros() -> None:
    from datetime import datetime

    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.append(["Code postal", "Dept", "Montant", "Date", "Qté", "Réf"])
    ws.append(["01000", "01", 12.5, datetime(2026, 1, 5), 3, "123"])
    ws.append(["75001", "75", 980, datetime(2026, 1, 31), None, "456"])
    buffer = io.BytesIO()
    wb.save(buffer)
    df, _ = read_table("codes.xlsx", buffer.getvalue())

    assert types(df) == {
        "Code postal": "string",
        "Dept": "string",
        "Montant": "number",
        "Date": "date",
        "Qté": "number",
        "Réf": "number",  # texte sans zéro en tête : un nombre, comme en CSV
    }
    assert df["Code postal"].tolist() == ["01000", "75001"]  # et non 1000, 75001
    assert df["Dept"].tolist() == ["01", "75"]
    assert df["Montant"].tolist() == [12.5, 980.0]
    assert df["Date"].iloc[1] == pd.Timestamp("2026-01-31")
    assert pd.isna(df["Qté"].iloc[1])


def test_json_records_nested_under_key() -> None:
    payload = {"data": [{"a": 1, "b": {"c": "x"}}, {"a": 2, "b": {"c": "y"}}]}
    df, fmt = read_table("d.json", json.dumps(payload).encode())
    assert fmt == "json"
    assert list(df.columns) == ["a", "b.c"]


def test_json_lists_become_text() -> None:
    # Un champ tableau (« tags ») d'une réponse d'API : du texte JSON, pas une erreur au profilage.
    payload = [{"id": 1, "tags": ["a", "é"], "lignes": [{"q": 2}]}, {"id": 2, "tags": [], "lignes": None}]
    df, _ = read_table("api.json", json.dumps(payload).encode())
    assert types(df) == {"id": "number", "tags": "string", "lignes": "string"}
    assert df["tags"].tolist() == ['["a", "é"]', "[]"]
    assert df["lignes"].iloc[0] == '[{"q": 2}]' and pd.isna(df["lignes"].iloc[1])


def test_dates_with_different_utc_offsets_become_local_time(local_tz: Callable[[str], None]) -> None:
    # Export en heure locale à cheval sur le changement d'heure : +01:00 puis +02:00 dans la même colonne.
    local_tz("Europe/Paris")
    stamps = ["2026-03-28T10:30:00+01:00", "2026-03-29T11:00:00+02:00"]
    csv_df, _ = read_table("x.csv", ("quand;v\n" + "".join(f"{s};1\n" for s in stamps)).encode())
    json_df, _ = read_table("x.json", json.dumps([{"quand": s} for s in stamps]).encode())
    for df in (csv_df, json_df):
        assert types(df)["quand"] == "date"
        assert [str(v) for v in df["quand"]] == ["2026-03-28 10:30:00", "2026-03-29 11:00:00"]
        assert df["quand"].dt.tz is None


def test_a_failing_conversion_leaves_the_column_as_text(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(series: pd.Series) -> pd.Series:
        raise ValueError("cas imprévu de pandas")

    monkeypatch.setattr(parsing, "_to_date", boom)
    df, _ = read_table("x.csv", b"jour;n\n05/01/2026;1\n06/01/2026;2\n")
    assert types(df) == {"jour": "string", "n": "number"}  # import réussi, jamais d'erreur 500


def xlsx(rows: list[list[object]]) -> bytes:
    from openpyxl import Workbook

    wb = Workbook()
    for row in rows:
        wb.active.append(row)
    buffer = io.BytesIO()
    wb.save(buffer)
    return buffer.getvalue()


TITLED = {"Date": "date", "Région": "string", "Montant": "number"}


@pytest.mark.parametrize(
    "content",
    [
        "Rapport des ventes 2026\n\nDate;Région;Montant\n05/01/2026;Nord;12,5\n06/01/2026;Sud;8\n",
        # Le même tableau enregistré depuis Excel : la ligne de titre est complétée par des séparateurs.
        "Rapport des ventes 2026;;\n;;\nDate;Région;Montant\n05/01/2026;Nord;12,5\n06/01/2026;Sud;8\n",
        "Société X\nExport du 12/03/2026\n\nDate;Région;Montant\n05/01/2026;Nord;12,5\n06/01/2026;Sud;8\n",
        "Sales report 2026\n\nDate,Région,Montant\n2026-01-05,Nord,12.5\n2026-01-06,Sud,8\n",
    ],
)
def test_csv_title_lines_above_the_table_are_skipped(content: str) -> None:
    df, _ = read_table("rapport.csv", content.encode())
    assert types(df) == TITLED
    assert df["Montant"].tolist() == [12.5, 8.0] and df["Région"].tolist() == ["Nord", "Sud"]


def test_xlsx_title_lines_above_the_table_are_skipped() -> None:
    from datetime import datetime

    rows = [
        ["Rapport des ventes 2026"],
        [],
        ["Date", "Région", "Montant"],
        [datetime(2026, 1, 5), "Nord", 12.5],
        [datetime(2026, 1, 6), "Sud", 8],
    ]
    df, _ = read_table("rapport.xlsx", xlsx(rows))
    assert types(df) == TITLED
    assert df["Montant"].tolist() == [12.5, 8.0] and df["Date"].iloc[0] == pd.Timestamp("2026-01-05")


def test_files_without_title_are_read_as_before() -> None:
    # Première ligne d'une seule cellule, mais suivie de données : c'est l'en-tête, jamais une ligne de titre.
    df, _ = read_table("x.csv", b"nom;\nA;1\nB;2\n")
    assert list(df.columns) == ["nom", "colonne_2"] and df["nom"].tolist() == ["A", "B"]
    # Classeur : en-têtes en double nommés comme avant (« a.1 »), les jeux déjà importés gardent leurs colonnes.
    df, _ = read_table("x.xlsx", xlsx([["a", "a", None, "b", "a", "a.1", 2024], [1, 2, 3, 4, 5, 6, 7]]))
    assert list(df.columns) == ["a", "a.2", "colonne_3", "b", "a.3", "a.1", "2024"]
    assert types(df)["a"] == "number"


@pytest.mark.parametrize(
    ("rows", "expected"),
    [
        ([["Date", "Montant"], ["05/01/2026", "12,5"]], 0),
        ([["Titre"], [], ["Date", "Montant"], ["05/01/2026", "12,5"], ["06/01/2026", "8"]], 2),
        ([["Titre", None, ""], [None, None, None], ["Date", "Région", "Montant"], ["x", "N", 1], ["y", "S", 2]], 2),
        ([["a", "a", ""], ["1", "2", "3"]], 0),  # en-tête avec une cellule vide : toujours l'en-tête
        ([["nom", ""], ["A", "1"], ["B", "2"]], 0),  # la ligne suivante porte un nombre : ce sont des données
        ([["Titre"], ["2026", "12"], ["2027", "15"]], 0),
        ([["code"], ["A1"], ["12"]], 0),  # tableau d'une seule colonne : rien à deviner
        ([], 0),
    ],
)
def test_header_row(rows: list[list[object]], expected: int) -> None:
    assert header_row(rows) == expected


def test_ragged_csv_error_is_in_french_with_the_line() -> None:
    with pytest.raises(DatasetError, match="Ligne 4 : 3 colonnes au lieu de 2") as info:
        read_table("x.csv", b"a;b\n1;2\n3;4\n5;6;7\n8;9\n")
    assert "Error tokenizing" not in str(info.value)
    # Titre qui contient lui-même le séparateur : pas deviné, mais le message dit quoi faire.
    with pytest.raises(DatasetError, match="Ligne 3 : 3 colonnes au lieu de 2.*ligne de titre"):
        read_table("x.csv", b"Sales report, 2026\n\nday,city,revenue\n2026-03-01,Paris,10\n")


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
