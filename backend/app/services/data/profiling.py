"""Profilage des colonnes et sérialisation JSON des lignes."""

import math
from datetime import date, datetime
from decimal import Decimal
from typing import Any

import numpy as np
import pandas as pd

from app.schemas.dataset import ColumnProfile, ColumnType, Scalar, ValueCount

TOP_VALUES = 5


def column_type(series: pd.Series) -> ColumnType:
    """Type logique d'une colonne, tel qu'affiché dans le panneau Champs."""
    if pd.api.types.is_bool_dtype(series):
        return "boolean"
    if pd.api.types.is_numeric_dtype(series):
        return "number"
    if pd.api.types.is_datetime64_any_dtype(series):
        return "date"
    return "string"


def profile_column(name: str, series: pd.Series) -> ColumnProfile:
    """Statistiques d'une colonne : manquants, distincts, bornes, moyenne, valeurs fréquentes."""
    kind = column_type(series)
    present = series.dropna()
    profile = ColumnProfile(
        name=name,
        type=kind,
        nulls=int(series.isna().sum()),
        distinct=int(present.nunique()),
    )
    if present.empty:
        return profile
    if kind == "number":
        profile.min, profile.max = to_json(present.min()), to_json(present.max())
        profile.mean = round(float(present.mean()), 4)
    elif kind == "date":
        profile.min, profile.max = to_json(present.min()), to_json(present.max())
    else:
        counts = present.astype(str).value_counts().head(TOP_VALUES)
        profile.top_values = [ValueCount(value=str(v), count=int(c)) for v, c in counts.items()]
    return profile


def build_profile(df: pd.DataFrame) -> list[ColumnProfile]:
    """Profil de toutes les colonnes."""
    return [profile_column(str(col), df[col]) for col in df.columns]


def to_json(value: Any) -> Scalar:
    """Convertit une valeur pandas/numpy en scalaire JSON (NaN/NaT → None, dates → ISO 8601)."""
    if value is None or value is pd.NaT:
        return None
    if isinstance(value, pd.Timestamp | datetime | date):
        stamp = pd.Timestamp(value)
        return stamp.date().isoformat() if stamp == stamp.normalize() else stamp.isoformat()
    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, Decimal):
        value = float(value)  # DuckDB renvoie des DECIMAL (ex. ca * 1.2) : nombre JSON, pas texte
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    if value is pd.NA:
        return None
    if isinstance(value, bool | int | float | str):
        return value
    return str(value)


def records(df: pd.DataFrame, offset: int = 0, limit: int | None = None) -> list[dict[str, Any]]:
    """Lignes au format JSON (liste d'objets), avec pagination."""
    page = df.iloc[offset : None if limit is None else offset + limit]
    return [{str(k): to_json(v) for k, v in row.items()} for row in page.to_dict(orient="records")]
