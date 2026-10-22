"""Conversions vers et depuis la table d'échange `atelier-table/1` (docs/SUITE.md §7.2).

- Jeu de données → table : colonnes du profil (clé snake_case sans accent, libellé = nom affiché),
  types `number | string | boolean`, `date` (minuit partout) ou `datetime` (heure présente).
- Résultat de `run_query` → table : clés `sum(CA)` → `sum_ca`, `sum(CA)@ytd` → `sum_ca_ytd`,
  `date|month` → `date_month` ; libellés lisibles (« Somme de CA », « date (Mois) »).
- Table reçue → DataFrame : une colonne par `key`, nommée par son `label` (comme le connecteur Atelier Projets),
  types forcés selon `type` (aucune réinterprétation).

Fonctions pures, sauf `dataset_table` (DuckDB, synchrone : via `asyncio.to_thread`).
"""

from __future__ import annotations

import json
import re
import unicodedata
from collections.abc import Iterable
from datetime import date, datetime
from typing import Any

import pandas as pd

from app.schemas.atelier import AtelierColumn, AtelierTable, AtelierType
from app.schemas.dataset import ColumnType
from app.schemas.query import DateBin, Measure, QueryRequest, QueryResponse, ShowKind
from app.services.connectors.base import unique_names
from app.services.data.profiling import to_json
from app.services.data.store import StoredDataset
from app.services.engine.database import LocalDatabase, quote_ident

AGG_LABELS = {
    "sum": "Somme",
    "avg": "Moyenne",
    "median": "Médiane",
    "min": "Minimum",
    "max": "Maximum",
    "count": "Nombre",
    "count_distinct": "Nombre distinct",
}
BIN_LABELS: dict[DateBin, str] = {
    "year": "Année",
    "quarter": "Trimestre",
    "month": "Mois",
    "week": "Semaine",
    "day": "Jour",
}
SHOW_LABELS: dict[ShowKind, str] = {
    "ytd": "Cumul annuel",
    "running": "Cumul",
    "prev_year": "N-1",
    "yoy_diff": "Écart vs N-1",
    "yoy_pct": "Évolution vs N-1",
    "moving_avg": "Moyenne mobile",
    "pct_total": "Part du total",
}


class TableError(ValueError):
    """Table d'échange inexploitable (message en français, renvoyé en 422 `VALIDATION`)."""


# --- Clés ---------------------------------------------------------------------------------------


def snake_key(text: str, fallback: str = "colonne") -> str:
    """`snake_case` ASCII : « Heures estimées » → `heures_estimees`, « sum(CA)@ytd » → `sum_ca_ytd`."""
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode("ascii")
    key = re.sub(r"[^a-z0-9]+", "_", ascii_text.lower()).strip("_")
    if not key:
        key = fallback
    if key[0].isdigit():
        key = f"{fallback}_{key}"
    return key[:100]


def unique_keys(texts: Iterable[str]) -> list[str]:
    """Clés snake_case uniques dans l'ordre (« ca », « ca_2 »…)."""
    out: list[str] = []
    taken: set[str] = set()
    for i, text in enumerate(texts):
        base = snake_key(text, f"colonne_{i + 1}")
        key, n = base, 2
        while key in taken:
            key, n = f"{base}_{n}", n + 1
        taken.add(key)
        out.append(key)
    return out


# --- Jeu de données → table -----------------------------------------------------------------------


def _date_value(value: Any, kind: AtelierType) -> Any:
    """Date `AAAA-MM-JJ` ou horodatage ISO 8601 avec fuseau (heure locale de la machine)."""
    if value is None:
        return None
    if isinstance(value, datetime):
        if kind == "date":
            return value.date().isoformat()
        aware = value if value.tzinfo else value.astimezone()  # horodatage naïf = heure locale de la machine
        return aware.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return to_json(value)


def _cell(value: Any, kind: AtelierType) -> Any:
    if kind in {"date", "datetime"}:
        return _date_value(value, kind)
    return to_json(value)


def _datetime_columns(db: LocalDatabase, source: str, names: list[str], types: list[ColumnType]) -> set[str]:
    """Colonnes date qui portent une heure quelque part dans le jeu (type stable d'une page à l'autre)."""
    dates = [n for n, t in zip(names, types, strict=True) if t == "date"]
    if not dates:
        return set()
    parts = [f"bool_or(CAST({quote_ident(n)} AS TIME) <> TIME '00:00:00')" for n in dates]
    _, rows = db.execute(f"SELECT {', '.join(parts)} FROM {quote_ident(source)}")
    flags = rows[0] if rows else (None,) * len(dates)
    return {n for n, flag in zip(dates, flags, strict=True) if flag}


def dataset_table(db: LocalDatabase, dataset: StoredDataset, offset: int, limit: int) -> AtelierTable:
    """Page de lignes d'un jeu (vue avec colonnes calculées et liées) au format `atelier-table/1`."""
    profile = dataset.profile_data
    names = [c.name for c in profile.columns]
    types: list[ColumnType] = [c.type for c in profile.columns]
    timed = _datetime_columns(db, dataset.source, names, types)
    kinds: list[AtelierType] = [
        ("datetime" if n in timed else "date") if t == "date" else t for n, t in zip(names, types, strict=True)
    ]
    select = ", ".join(quote_ident(n) for n in names)
    _, rows = db.execute(f"SELECT {select} FROM {quote_ident(dataset.source)} LIMIT ? OFFSET ?", [limit, offset])
    keys = unique_keys(names)
    columns = [AtelierColumn(key=k, label=n, type=t) for k, n, t in zip(keys, names, kinds, strict=True)]
    total = profile.rows
    return AtelierTable(
        name=snake_key(profile.name, "jeu"),
        label=profile.name,
        columns=columns,
        rows=[{k: _cell(v, t) for k, v, t in zip(keys, row, kinds, strict=True)} for row in rows],
        total=total,
        truncated=offset > 0 or offset + len(rows) < total,
    )


# --- Résultat de requête → table ----------------------------------------------------------------


def measure_label(m: Measure) -> str:
    """Libellé français d'une mesure, comme le Studio (« Somme de CA », « Cumul annuel — Somme de CA »)."""
    if m.agg == "calc":
        base = m.field or "Mesure"
    elif m.field is None:
        base = "Nombre de lignes"
    else:
        base = f"{AGG_LABELS[m.agg]} de {m.field}"
    if m.show is None:
        return base
    extra = f" ({m.show.window} périodes)" if m.show.kind == "moving_avg" else ""
    return f"{SHOW_LABELS[m.show.kind]}{extra} — {base}"


def query_key(key: str) -> str:
    """Clé snake_case d'une colonne de requête : `sum(CA)@ytd` → `sum_ca_ytd`, `date|month` → `date_month`,
    `count(*)` → `count`."""
    return snake_key(key.replace("(*)", ""), "colonne")


def query_table(req: QueryRequest, res: QueryResponse, name: str, label: str | None) -> AtelierTable:
    """Résultat de `run_query` (lignes en listes) → table d'échange (lignes en objets par clé snake_case)."""
    labels: dict[str, str] = {}
    for d in req.dimensions:
        labels[d.key] = f"{d.field} ({BIN_LABELS[d.bin]})" if d.bin else d.field
    for m in req.measures:
        labels[m.key] = measure_label(m)
    labels["__grouping"] = "Niveau de regroupement"
    raw_keys = [c.key for c in res.columns]
    # Clés uniques : `sum(CA)` et `sum(ca)` donneraient la même clé.
    keys: list[str] = []
    taken: set[str] = set()
    for raw in raw_keys:
        base = "niveau_regroupement" if raw == "__grouping" else query_key(raw)
        key, n = base, 2
        while key in taken:
            key, n = f"{base}_{n}", n + 1
        taken.add(key)
        keys.append(key)
    types: list[ColumnType] = [c.type for c in res.columns]
    kinds: list[AtelierType] = [
        ("datetime" if _iso_has_time(r[i] for r in res.rows) else "date") if t == "date" else t
        for i, t in enumerate(types)
    ]
    columns = [
        AtelierColumn(key=k, label=labels.get(raw, raw), type=t)
        for k, raw, t in zip(keys, raw_keys, kinds, strict=True)
    ]
    rows = [{k: _query_cell(v, t) for k, v, t in zip(keys, row, kinds, strict=True)} for row in res.rows]
    return AtelierTable(
        name=name,
        label=label,
        columns=columns,
        rows=rows,
        total=None if res.truncated else len(rows),
        truncated=res.truncated,
    )


def _query_cell(value: Any, kind: AtelierType) -> Any:
    """Les valeurs de `run_query` sont déjà en JSON (dates en texte ISO) : seules les dates sont reformatées."""
    if value is None or kind not in {"date", "datetime"}:
        return value
    try:
        parsed = datetime.fromisoformat(str(value))
    except ValueError:
        return value
    return _date_value(parsed, kind)


def _iso_has_time(values: Iterable[Any]) -> bool:
    """Vrai si une valeur ISO renvoyée par le moteur porte une heure (« 2026-01-02T10:30:00 »)."""
    return any(isinstance(v, str) and "T" in v for v in values)


# --- Table reçue → DataFrame ----------------------------------------------------------------------


def _number(v: Any) -> Any:
    if isinstance(v, bool) or v is None:
        return None
    if isinstance(v, (int, float)):
        return v
    if isinstance(v, str):
        try:
            return float(v.strip().replace(",", "."))
        except ValueError:
            return None
    return None


def _boolean(v: Any) -> Any:
    if isinstance(v, bool):
        return v
    if isinstance(v, str) and v.strip().lower() in {"true", "vrai", "oui", "1"}:
        return True
    if isinstance(v, str) and v.strip().lower() in {"false", "faux", "non", "0"}:
        return False
    return None


def _text(v: Any) -> Any:
    if v is None:
        return None
    if isinstance(v, str):
        return v
    if isinstance(v, (dict, list)):
        return json.dumps(v, ensure_ascii=False)
    return str(v)


def _series(kind: AtelierType, values: list[Any]) -> pd.Series:
    """Colonne typée selon le type annoncé (aucune réinterprétation des valeurs)."""
    if kind == "number":
        return pd.to_numeric(pd.Series([_number(v) for v in values], dtype="object"), errors="coerce")
    if kind == "boolean":
        return pd.Series([_boolean(v) for v in values], dtype="boolean")
    if kind in {"date", "datetime"}:
        texts = pd.Series([v if isinstance(v, str) and v.strip() else None for v in values], dtype="object")
        converted = pd.to_datetime(texts, errors="coerce", utc=True, format="ISO8601")
        if kind == "date":  # AAAA-MM-JJ : jour calendaire, sans décalage horaire
            return converted.dt.tz_localize(None).dt.normalize().astype("datetime64[ns]")
        # Horodatage avec fuseau → heure locale de la machine, sans fuseau (comme le connecteur Atelier Projets).
        local = [None if pd.isna(ts) else ts.to_pydatetime().astimezone().replace(tzinfo=None) for ts in converted]
        return pd.Series(pd.to_datetime(local), dtype="datetime64[ns]")
    return pd.Series([_text(v) for v in values], dtype="string")


def table_frame(table: AtelierTable) -> pd.DataFrame:
    """Table d'échange → DataFrame : une colonne par `key`, nommée par son libellé (rendu unique)."""
    names = unique_names([c.label.strip() or c.key for c in table.columns])
    bad = [n for n in names if n.startswith("__") or any(ch in n for ch in '|[]"\n\r\t')]
    if bad:
        raise TableError(
            f'Libellé de colonne invalide : « {bad[0]} » (caractères | [ ] " interdits, ni « __ » au début).'
        )
    known = {c.key for c in table.columns}
    for i, row in enumerate(table.rows):
        unknown = set(row) - known
        if unknown:
            raise TableError(f"Ligne {i + 1} : clé(s) absente(s) des colonnes : {', '.join(sorted(unknown)[:5])}.")
    data = {
        name: _series(col.type, [r.get(col.key) for r in table.rows])
        for name, col in zip(names, table.columns, strict=True)
    }
    return pd.DataFrame(data)
