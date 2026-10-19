"""Lecture de fichiers CSV / XLSX / JSON en DataFrame, avec inférence de types tolérante.

Les CSV français (séparateur `;`, décimale `,`, espaces de milliers, dates JJ/MM/AAAA)
sont gérés aussi bien que les CSV anglo-saxons.
"""

import csv
import io
import json
import re
from pathlib import PurePath

import pandas as pd

from app.schemas.dataset import SourceFormat

SEPARATORS = ",;\t|"
ENCODINGS = ("utf-8-sig", "cp1252")
MIN_MATCH_RATIO = 0.95  # part minimale de valeurs convertibles pour retyper une colonne

_NUMBER_RE = re.compile(r"^[-+]?(\d{1,3}([   .,]\d{3})+|\d+)([.,]\d+)?\s*%?$")
_DATE_HINT_RE = re.compile(r"^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}")
_TRUE = {"true", "vrai", "oui", "yes"}
_FALSE = {"false", "faux", "non", "no"}


class DatasetError(ValueError):
    """Fichier illisible ou format non pris en charge (renvoyé en HTTP 422)."""


def detect_format(filename: str) -> SourceFormat:
    """Déduit le format de l'extension du fichier."""
    suffix = PurePath(filename).suffix.lower()
    formats: dict[str, SourceFormat] = {".csv": "csv", ".txt": "csv", ".tsv": "csv", ".xlsx": "xlsx", ".json": "json"}
    if suffix not in formats:
        raise DatasetError(f"Format « {suffix or 'sans extension'} » non pris en charge (CSV, XLSX ou JSON).")
    return formats[suffix]


def read_table(filename: str, content: bytes) -> tuple[pd.DataFrame, SourceFormat]:
    """Lit le fichier et retourne un DataFrame aux colonnes typées."""
    fmt = detect_format(filename)
    if not content.strip():
        raise DatasetError("Le fichier est vide.")
    try:
        if fmt == "csv":
            df = _read_csv(content)
        elif fmt == "xlsx":
            df = pd.read_excel(io.BytesIO(content), sheet_name=0, engine="openpyxl")
        else:
            df = _read_json(content)
    except DatasetError:
        raise
    except Exception as exc:  # pandas lève des exceptions très variées
        raise DatasetError(f"Lecture impossible du fichier {fmt.upper()} : {exc}") from exc

    df = _clean_columns(df)
    if df.empty or len(df.columns) == 0:
        raise DatasetError("Aucune donnée exploitable dans le fichier.")
    return infer_types(df), fmt


def _decode(content: bytes) -> str:
    for encoding in ENCODINGS:
        try:
            return content.decode(encoding)
        except UnicodeDecodeError:
            continue
    raise DatasetError("Encodage non reconnu (UTF-8 ou Windows-1252 attendus).")


def _read_csv(content: bytes) -> pd.DataFrame:
    text = _decode(content)
    head = text[:65_536]
    try:
        sep = csv.Sniffer().sniff(head, delimiters=SEPARATORS).delimiter
    except csv.Error:
        # Repli : le séparateur le plus fréquent sur la première ligne.
        first_line = head.splitlines()[0] if head else ""
        sep = max(SEPARATORS, key=first_line.count)
    # Tout est lu en texte (infer_types gère ensuite décimales et dates françaises).
    # header=None : les en-têtes dupliqués sont renommés par _clean_columns, pas par pandas (« a.1 »).
    raw = pd.read_csv(io.StringIO(text), sep=sep, dtype=str, header=None, skipinitialspace=True)
    if raw.empty:
        raise DatasetError("Le fichier ne contient aucune ligne.")
    df = raw.iloc[1:].reset_index(drop=True)
    df.columns = list(raw.iloc[0])
    return df


def _read_json(content: bytes) -> pd.DataFrame:
    data = json.loads(_decode(content))
    if isinstance(data, dict):
        # {"data": [...]} ou {"records": [...]} : on prend la première liste trouvée.
        lists = [v for v in data.values() if isinstance(v, list)]
        if not lists:
            raise DatasetError("JSON attendu : une liste d'objets, ou un objet contenant une telle liste.")
        data = lists[0]
    if not isinstance(data, list):
        raise DatasetError("JSON attendu : une liste d'objets.")
    return pd.json_normalize(data)


def _clean_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Noms de colonnes propres et uniques ; lignes et colonnes entièrement vides supprimées."""
    df = df.dropna(how="all").dropna(axis=1, how="all")
    names: list[str] = []
    for i, col in enumerate(df.columns):
        name = "" if pd.isna(col) else str(col).strip()
        if not name or name.startswith("Unnamed:"):
            name = f"colonne_{i + 1}"
        base, n = name, 2
        while name in names:
            name, n = f"{base}_{n}", n + 1
        names.append(name)
    df.columns = names
    return df.reset_index(drop=True)


def infer_types(df: pd.DataFrame) -> pd.DataFrame:
    """Convertit les colonnes texte en nombre, date ou booléen quand ≥ 95 % des valeurs s'y prêtent."""
    out = df.copy()
    for col in out.columns:
        series = out[col]
        if not (pd.api.types.is_object_dtype(series) or pd.api.types.is_string_dtype(series)):
            continue
        values = series.dropna().astype(str).str.strip()
        values = values[values != ""]
        if values.empty:
            continue
        for convert in (_to_bool, _to_number, _to_date):
            converted = convert(series)
            if converted is not None and converted.notna().sum() >= MIN_MATCH_RATIO * len(values):
                out[col] = converted
                break
    return out


def _to_bool(series: pd.Series) -> pd.Series | None:
    lowered = series.astype("string").str.strip().str.lower()
    if not lowered.dropna().isin(_TRUE | _FALSE).all():
        return None
    return lowered.map(lambda v: True if v in _TRUE else False if v in _FALSE else None).astype("boolean")


def _to_number(series: pd.Series) -> pd.Series | None:
    text = series.astype("string").str.strip()
    sample = text.dropna()
    if sample.empty or not sample.str.match(_NUMBER_RE).mean() >= MIN_MATCH_RATIO:
        return None
    # Zéro en tête (« 01000 », « 06 ») : code postal, département, SIRET… → reste du texte.
    if sample.str.match(r"^[-+]?0\d").any():
        return None
    # Décimale « , » si aucune valeur n'utilise « , » comme séparateur de milliers anglo-saxon.
    comma_decimal = sample.str.contains(r",\d+\s*%?$").any() and not sample.str.contains(r"\.\d+,").any()
    cleaned = text.str.replace(r"[\s  %]", "", regex=True)
    if comma_decimal:
        cleaned = cleaned.str.replace(".", "", regex=False).str.replace(",", ".", regex=False)
    else:
        cleaned = cleaned.str.replace(",", "", regex=False)
    return pd.to_numeric(cleaned, errors="coerce")


def _to_date(series: pd.Series) -> pd.Series | None:
    text = series.astype("string").str.strip()
    sample = text.dropna()
    if sample.empty or not sample.str.match(_DATE_HINT_RE).mean() >= MIN_MATCH_RATIO:
        return None
    iso = sample.str.match(r"^\d{4}-").mean() >= MIN_MATCH_RATIO
    return pd.to_datetime(text, errors="coerce", dayfirst=not iso, format="mixed")
