"""Préparation des données : étapes appliquées à la source avant le profilage (comme Power Query).

Les étapes sont des opérations typées (jamais de code ni de SQL venant du client), appliquées à un
DataFrame pandas dans l'ordre. Elles sont enregistrées avec le jeu et rejouées sur les nouvelles
données à chaque actualisation ; la source brute est gardée dans la table `raw_<id>`.
"""

from __future__ import annotations

import re
from collections.abc import Sequence

import pandas as pd

from app.schemas.dataset import (
    CastStep,
    DedupeStep,
    FillStep,
    FilterStep,
    PrepStep,
    RemoveStep,
    RenameStep,
    ReplaceStep,
    Scalar,
    SplitStep,
    TextStep,
    UnpivotStep,
)
from app.services.data.parsing import _FALSE, _TRUE, MIN_MATCH_RATIO
from app.services.data.profiling import column_type

MAX_ROWS = 20_000_000

_LABELS = {
    "rename": "Renommer",
    "remove": "Supprimer des colonnes",
    "cast": "Changer le type",
    "filter": "Filtrer les lignes",
    "replace": "Remplacer des valeurs",
    "fill": "Remplir les vides",
    "text": "Nettoyer le texte",
    "dedupe": "Supprimer les doublons",
    "unpivot": "Dépivoter",
    "split": "Fractionner",
}


class PrepError(ValueError):
    """Étape impossible à appliquer (colonne absente, nom en double…)."""

    def __init__(self, index: int, step: PrepStep, message: str) -> None:
        super().__init__(f"Étape {index + 1} ({_LABELS[step.kind]}) : {message}")
        self.index = index
        self.message = message
        self.label = f"Étape {index + 1} · {_LABELS[step.kind]}"


def apply_steps(df: pd.DataFrame, steps: Sequence[PrepStep]) -> pd.DataFrame:
    """Applique les étapes dans l'ordre ; lève `PrepError` à la première étape impossible."""
    out = df
    for i, step in enumerate(steps):
        try:
            out = _APPLY[step.kind](out, step)
        except _StepError as exc:
            raise PrepError(i, step, str(exc)) from exc
        if len(out) > MAX_ROWS:
            raise PrepError(i, step, f"résultat trop volumineux (plus de {MAX_ROWS:,} lignes).".replace(",", " "))
    return out.reset_index(drop=True)


class _StepError(ValueError):
    pass


def _need(df: pd.DataFrame, *columns: str) -> None:
    missing = [c for c in columns if c not in df.columns]
    if missing:
        raise _StepError(f"colonne introuvable : {', '.join(f'« {c} »' for c in missing)}.")


def _free(df: pd.DataFrame, name: str, allowed: str | None = None) -> None:
    if name != allowed and name.lower() in {str(c).lower() for c in df.columns if c != allowed}:
        raise _StepError(f"« {name} » existe déjà.")


# --- Conversions ---------------------------------------------------------------------------------


def _to_number(series: pd.Series) -> pd.Series:
    if pd.api.types.is_bool_dtype(series):
        return series.astype("Float64").astype(float)
    if pd.api.types.is_numeric_dtype(series):
        return series
    text = series.astype("string").str.strip().str.replace(r"[\s  %€$]", "", regex=True)
    # « 1.234,5 » ou « 1234,5 » : virgule décimale ; « 1,234.5 » : virgule des milliers.
    french = text.str.contains(r",\d+$", na=False) & ~text.str.contains(r"\.\d+,", na=False)
    text = text.where(~french, text.str.replace(".", "", regex=False).str.replace(",", ".", regex=False))
    text = text.where(french, text.str.replace(",", "", regex=False))
    return pd.to_numeric(text, errors="coerce").astype(float)


def _to_date(series: pd.Series) -> pd.Series:
    if pd.api.types.is_datetime64_any_dtype(series):
        return series
    if pd.api.types.is_numeric_dtype(series):
        return pd.to_datetime(series, errors="coerce", unit="D", origin="1899-12-30")  # numéro de série Excel
    text = series.astype("string").str.strip()
    present = text.dropna()
    iso = not present.empty and present.str.match(r"^\d{4}-").mean() >= MIN_MATCH_RATIO
    return pd.to_datetime(text, errors="coerce", dayfirst=not iso, format="mixed")


def _to_bool(series: pd.Series) -> pd.Series:
    if pd.api.types.is_bool_dtype(series):
        return series
    if pd.api.types.is_numeric_dtype(series):
        return series.map(lambda v: None if pd.isna(v) else bool(v)).astype("boolean")
    lowered = series.astype("string").str.strip().str.lower()
    return lowered.map(lambda v: True if v in _TRUE or v == "1" else False if v in _FALSE or v == "0" else None).astype(
        "boolean"
    )


def _to_string(series: pd.Series) -> pd.Series:
    if pd.api.types.is_datetime64_any_dtype(series):
        out = series.dt.strftime("%Y-%m-%d")
    elif pd.api.types.is_float_dtype(series):
        out = series.map(lambda v: None if pd.isna(v) else (str(int(v)) if float(v).is_integer() else str(v)))
    else:
        out = series.map(lambda v: None if pd.isna(v) else str(v))
    return out.astype("string").astype(object).where(series.notna(), None)


_CASTS = {"number": _to_number, "date": _to_date, "boolean": _to_bool, "string": _to_string}


def _like(series: pd.Series, values: list[Scalar]) -> list:
    """Valeurs saisies converties dans le type de la colonne (« 10 » pour un nombre, « 01/02/2026 » pour une date)."""
    raw = pd.Series([v for v in values if v is not None], dtype=object)
    if raw.empty:
        return []
    kind = column_type(series)
    if kind == "number":
        converted = _to_number(raw)
    elif kind == "date":
        converted = _to_date(raw)
    elif kind == "boolean":
        converted = _to_bool(raw)
    else:
        return [str(v) for v in raw]
    if converted.isna().any():
        bad = raw[converted.isna()].iloc[0]
        raise _StepError(f"« {bad} » n'est pas une valeur valide pour une colonne de type {kind}.")
    return list(converted)


# --- Étapes ---------------------------------------------------------------------------------------


def _rename(df: pd.DataFrame, s: RenameStep) -> pd.DataFrame:
    _need(df, s.column)
    _free(df, s.to, allowed=s.column)
    return df.rename(columns={s.column: s.to})


def _remove(df: pd.DataFrame, s: RemoveStep) -> pd.DataFrame:
    _need(df, *s.columns)
    if len(set(s.columns)) >= len(df.columns):
        raise _StepError("il doit rester au moins une colonne.")
    return df.drop(columns=s.columns)


def _cast(df: pd.DataFrame, s: CastStep) -> pd.DataFrame:
    _need(df, s.column)
    out = df.copy()
    out[s.column] = _CASTS[s.to](out[s.column])
    return out


def _filter(df: pd.DataFrame, s: FilterStep) -> pd.DataFrame:
    _need(df, s.column)
    col = df[s.column]
    if s.op == "is_null":
        return df[col.isna()]
    if s.op == "not_null":
        return df[col.notna()]
    if s.op in {"contains", "not_contains"}:
        if not s.values or s.values[0] is None:
            raise _StepError("indiquez le texte recherché.")
        hit = col.astype("string").str.contains(str(s.values[0]), case=False, regex=False).fillna(False).astype(bool)
        return df[hit if s.op == "contains" else ~hit]
    values = _like(col, s.values)
    if not values:
        raise _StepError("indiquez au moins une valeur.")
    if s.op in {"in", "not_in", "eq", "neq"}:
        hit = col.isin(values if s.op in {"in", "not_in"} else values[:1]).fillna(False).astype(bool)
        return df[hit if s.op in {"in", "eq"} else ~hit]
    if column_type(col) in {"string", "boolean"}:
        raise _StepError("comparaison (>, <) possible seulement sur un nombre ou une date.")
    v = values[0]
    mask = {"gt": col > v, "gte": col >= v, "lt": col < v, "lte": col <= v}[s.op]
    return df[mask.fillna(False).astype(bool)]


def _replace(df: pd.DataFrame, s: ReplaceStep) -> pd.DataFrame:
    _need(df, s.column)
    out = df.copy()
    col = out[s.column]
    if not s.whole:
        if column_type(col) != "string":
            raise _StepError("le remplacement dans le texte ne s'applique qu'à une colonne texte.")
        if s.find in (None, ""):
            raise _StepError("indiquez le texte à remplacer.")
        replaced = col.astype("string").str.replace(
            str(s.find), "" if s.replace is None else str(s.replace), regex=False
        )
        out[s.column] = replaced.astype(object).where(col.notna(), None)
        return out
    if s.find is None:
        target = col.isna()
    else:
        found = _like(col, [s.find])
        target = col == found[0] if found else pd.Series(False, index=col.index)
    new = None if s.replace is None else _like(col, [s.replace])[0]
    if new is None:
        out[s.column] = col.where(~target.fillna(False).astype(bool), None)
    else:
        out[s.column] = col.mask(target.fillna(False).astype(bool), new)
    return out


def _fill(df: pd.DataFrame, s: FillStep) -> pd.DataFrame:
    _need(df, s.column)
    out = df.copy()
    if s.down:
        out[s.column] = out[s.column].ffill()
    else:
        if s.value is None:
            raise _StepError("indiquez la valeur de remplacement.")
        out[s.column] = out[s.column].fillna(_like(out[s.column], [s.value])[0])
    return out


def _text(df: pd.DataFrame, s: TextStep) -> pd.DataFrame:
    _need(df, s.column)
    col = df[s.column]
    if column_type(col) != "string":
        raise _StepError("cette étape s'applique à une colonne texte.")
    text = col.astype("string")
    if s.mode == "trim":
        text = text.str.replace(r"\s+", " ", regex=True).str.strip()
    elif s.mode == "upper":
        text = text.str.upper()
    elif s.mode == "lower":
        text = text.str.lower()
    else:
        text = text.str.lower().str.replace(r"(^|[\s\-'])(\w)", lambda m: m.group(1) + m.group(2).upper(), regex=True)
    out = df.copy()
    out[s.column] = text.astype(object).where(col.notna(), None)
    return out


def _dedupe(df: pd.DataFrame, s: DedupeStep) -> pd.DataFrame:
    if s.columns:
        _need(df, *s.columns)
    return df.drop_duplicates(subset=s.columns or None)


def _unpivot(df: pd.DataFrame, s: UnpivotStep) -> pd.DataFrame:
    _need(df, *s.columns)
    ids = [c for c in df.columns if c not in s.columns]
    for name in (s.attribute, s.value):
        if name.lower() in {str(c).lower() for c in ids}:
            raise _StepError(f"« {name} » existe déjà.")
    if s.attribute.lower() == s.value.lower():
        raise _StepError("les colonnes attribut et valeur doivent avoir des noms différents.")
    kinds = {column_type(df[c]) for c in s.columns}
    melted = df.melt(id_vars=ids, value_vars=s.columns, var_name=s.attribute, value_name=s.value)
    if len(kinds) > 1:  # types mélangés : la valeur devient du texte
        melted[s.value] = _to_string(melted[s.value])
    return melted


def _split(df: pd.DataFrame, s: SplitStep) -> pd.DataFrame:
    _need(df, s.column)
    if column_type(df[s.column]) != "string":
        raise _StepError("le fractionnement s'applique à une colonne texte.")
    if len({n.lower() for n in s.into}) != len(s.into):
        raise _StepError("les nouvelles colonnes doivent avoir des noms différents.")
    for name in s.into:
        _free(df, name, allowed=s.column)
    parts = df[s.column].astype("string").str.split(re.escape(s.separator), n=len(s.into) - 1, regex=True, expand=True)
    out = df.copy()
    position = list(out.columns).index(s.column)
    out = out.drop(columns=[s.column])
    for i, name in enumerate(s.into):
        values = parts[i].str.strip() if i in parts.columns else pd.Series(None, index=df.index, dtype="string")
        out.insert(position + i, name, values.astype(object).where(values.notna(), None))
    return out


_APPLY = {
    "rename": _rename,
    "remove": _remove,
    "cast": _cast,
    "filter": _filter,
    "replace": _replace,
    "fill": _fill,
    "text": _text,
    "dedupe": _dedupe,
    "unpivot": _unpivot,
    "split": _split,
}
