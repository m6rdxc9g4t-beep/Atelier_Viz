"""Lecture de fichiers CSV / XLSX / JSON en DataFrame, avec inférence de types tolérante.

Les CSV français (séparateur `;`, décimale `,`, espaces de milliers, dates JJ/MM/AAAA)
sont gérés aussi bien que les CSV anglo-saxons. Un JSON qui est une enveloppe DataFlow
d'Atelier Tab est aplati selon son propre schéma (`dataflow.py`, types gardés).
"""

import csv
import io
import json
import logging
import re
from pathlib import PurePath
from typing import Any

import pandas as pd

from app.schemas.dataset import SourceFormat
from app.services.data.dataflow import DataflowError, dataflow_frame, is_dataflow

logger = logging.getLogger(__name__)

SEPARATORS = ",;\t|"
ENCODINGS = ("utf-8-sig", "cp1252")
MIN_MATCH_RATIO = 0.95  # part minimale de valeurs convertibles pour retyper une colonne

_NUMBER_RE = re.compile(r"^[-+]?(\d{1,3}([   .,]\d{3})+|\d+)([.,]\d+)?\s*%?$")
_NOISE = "[\\s\u00a0\u202f%]"  # espaces (dont insécables : milliers français) et « % », retirés avant lecture
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


def read_table(filename: str, content: bytes, sheet: str | None = None) -> tuple[pd.DataFrame, SourceFormat]:
    """Lit le fichier et retourne un DataFrame aux colonnes typées (`sheet` : feuille Excel, sinon la première)."""
    fmt = detect_format(filename)
    if not content.strip():
        raise DatasetError("Le fichier est vide.")
    typed = False  # types déjà fixés par la source (enveloppe DataFlow) : pas d'inférence
    try:
        if fmt == "csv":
            df = _read_csv(content)
        elif fmt == "xlsx":
            df = _read_excel(content, sheet)
        else:
            data = json.loads(_decode(content))
            if is_dataflow(data):
                df, typed = dataflow_frame(data), True
            else:
                df = _json_frame(data)
    except DataflowError as exc:
        raise DatasetError(str(exc)) from exc
    except DatasetError:
        raise
    except Exception as exc:  # pandas lève des exceptions très variées
        raise DatasetError(f"Lecture impossible du fichier {fmt.upper()} : {exc}") from exc

    if typed:
        # Enveloppe DataFlow : colonnes déjà nommées, uniques et typées ; une colonne vide reste (contrat de la source).
        if df.empty:
            raise DatasetError("L'instantané Atelier Tab ne contient aucune ligne.")
        return df, fmt
    df = _clean_columns(df)
    if df.empty or len(df.columns) == 0:
        raise DatasetError("Aucune donnée exploitable dans le fichier.")
    return infer_types(df), fmt


def excel_sheets(content: bytes) -> list[str]:
    """Noms des feuilles d'un classeur Excel."""
    from openpyxl import load_workbook

    try:
        wb = load_workbook(io.BytesIO(content), read_only=True)
    except Exception as exc:  # noqa: BLE001 — openpyxl / zipfile
        raise DatasetError(f"Classeur Excel illisible : {exc}") from exc
    try:
        return list(wb.sheetnames)
    finally:
        wb.close()


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


def _read_excel(content: bytes, sheet: str | None) -> pd.DataFrame:
    # dtype=object : pandas ne réinterprète pas les cellules de texte (« 01000 » deviendrait 1000) ; seuls les types
    # natifs d'Excel (nombres, dates, booléens) sont retypés, le texte passe ensuite par infer_types comme un CSV.
    raw = pd.read_excel(io.BytesIO(content), sheet_name=sheet if sheet else 0, engine="openpyxl", dtype=object)
    return raw.infer_objects()


def _json_frame(data: object) -> pd.DataFrame:
    """Liste d'objets JSON (ou objet contenant une telle liste) → DataFrame."""
    if isinstance(data, dict):
        # {"data": [...]} ou {"records": [...]} : on prend la première liste trouvée.
        lists = [v for v in data.values() if isinstance(v, list)]
        if not lists:
            raise DatasetError("JSON attendu : une liste d'objets, ou un objet contenant une telle liste.")
        data = lists[0]
    if not isinstance(data, list):
        raise DatasetError("JSON attendu : une liste d'objets.")
    df = pd.json_normalize(data)
    # Un champ tableau (« tags » : […]) reste une liste après l'aplatissement : du texte JSON, sinon le profilage
    # (valeurs distinctes) et DuckDB échouent.
    for col in df.columns:
        if pd.api.types.is_object_dtype(df[col]) and df[col].map(lambda v: isinstance(v, (list, dict))).any():
            df[col] = df[col].map(_json_text)
    return df


def _json_text(v: Any) -> Any:
    if v is None or isinstance(v, str):
        return v
    if isinstance(v, (list, dict)):
        return json.dumps(v, ensure_ascii=False)
    return None if pd.isna(v) else str(v)


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
            try:
                converted = convert(series)
            except Exception as exc:  # noqa: BLE001 — filet : la colonne reste du texte, l'import n'échoue jamais ici
                logger.warning("Typage de la colonne « %s » abandonné (%s) : %s", col, convert.__name__, exc)
                continue
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
    return to_numbers(text)


def decimal_separator(sample: pd.Series) -> str | None:
    """Séparateur décimal d'une colonne de nombres écrits en texte : « , », « . », ou None si elle se contredit.

    Décidé sur toute la colonne (valeurs sans espace ni « % »), jamais valeur par valeur : « 12,000 » vaut
    douze mille à côté de « 1,234.50 » et douze à côté de « 3,25 ». Indices, par séparateur : il suit l'autre
    dans une même valeur (le dernier est la décimale), il précède 1, 2, ou 4 chiffres et plus en fin de valeur
    (pas un groupe de milliers), ou l'autre est répété (« 1.234.567 » : le point groupe, la virgule décide).
    Sans aucun indice (« 1,234 » seul), lecture française : la virgule est décimale.
    """
    comma = (
        sample.str.contains(r"\..*,\d+$")
        | sample.str.contains(r"^[^.,]*,(?:\d{1,2}|\d{4,})$")
        | (sample.str.count(r"\.") > 1)
    ).any()
    dot = (
        sample.str.contains(r",.*\.\d+$")
        | sample.str.contains(r"^[^.,]*\.(?:\d{1,2}|\d{4,})$")
        | (sample.str.count(",") > 1)
    ).any()
    if comma and dot:
        return None
    if comma or dot:
        return "," if comma else "."
    return "," if sample.str.contains(",", regex=False).any() else "."


def to_numbers(text: pd.Series) -> pd.Series | None:
    """Colonne de texte → nombres (vide si illisible) ; None si ses valeurs se contredisent sur le séparateur décimal.

    Seules les valeurs en forme de nombre suivent le séparateur de la colonne ; les autres sont laissées telles
    quelles à pandas (« 1e3 » reste lisible, « v1.2.3 » reste vide).
    """
    cleaned = text.str.replace(_NOISE, "", regex=True)
    shaped = cleaned.str.match(_NUMBER_RE).fillna(False).astype(bool)
    separator = decimal_separator(cleaned[shaped])
    if separator is None:
        return None
    if separator == ",":
        rewritten = cleaned.str.replace(".", "", regex=False).str.replace(",", ".", regex=False)
    else:
        rewritten = cleaned.str.replace(",", "", regex=False)
    return pd.to_numeric(rewritten.where(shaped, cleaned), errors="coerce")


def _to_date(series: pd.Series) -> pd.Series | None:
    text = series.astype("string").str.strip()
    sample = text.dropna()
    if sample.empty or not sample.str.match(_DATE_HINT_RE).mean() >= MIN_MATCH_RATIO:
        return None
    iso = sample.str.match(r"^\d{4}-").mean() >= MIN_MATCH_RATIO
    return to_dates(text, dayfirst=not iso)


def to_dates(text: pd.Series, dayfirst: bool) -> pd.Series:
    """Colonne de texte → dates (vide si illisible).

    Des décalages horaires différents dans la colonne (« +01:00 » puis « +02:00 » : export en heure locale à
    cheval sur le changement d'heure) font échouer pandas 3 ; elle est alors lue en UTC puis rendue à l'heure
    locale de la machine, sans fuseau (`local_naive`).
    """
    try:
        dates = pd.to_datetime(text, errors="coerce", dayfirst=dayfirst, format="mixed")
    except ValueError:
        dates = None
    if dates is None or not pd.api.types.is_datetime64_any_dtype(dates):  # pandas 2 : colonne d'objets
        dates = local_naive(pd.to_datetime(text, errors="coerce", dayfirst=dayfirst, format="mixed", utc=True))
    return dates


def local_naive(series: pd.Series) -> pd.Series:
    """Horodatages UTC → heure locale de la machine (heure d'été comprise), sans fuseau.

    Les apps de la suite envoient leurs `datetime` en ISO 8601 UTC (« …Z ») ; l'utilisateur les attend à l'heure
    de sa montre. `datetime.astimezone()` sans argument suit le fuseau du système (variable `TZ` comprise).
    """
    local = [None if pd.isna(ts) else ts.to_pydatetime().astimezone().replace(tzinfo=None) for ts in series]
    return pd.Series(pd.to_datetime(local), index=series.index, dtype="datetime64[ns]")
