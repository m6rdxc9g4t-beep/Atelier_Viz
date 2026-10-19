"""Enveloppes DataFlow v2.1.0 d'Atelier Tab (instantanés de tables) → DataFrame à plat.

Contrat : `docs/SUITE.md` §4.2 ; schéma de référence : `atelier-tab/src/dataflow/schema/atelier.v2_1.ts`.

- Une colonne par entrée de `project.columns_schema` (nom = `label`), précédée de `_ligne` (`row_index`)
  et `_id` (`record_id`).
- Valeur = `computed` (valeur évaluée par le moteur d'Atelier Tab) ; un code d'erreur (`#DIV/0!`, `#N/A`…) devient vide.
- Types déduits de `type` : `currency | number | percent` → nombre, `formula` → nombre si toutes ses valeurs le sont,
  `date` → date, `checkbox` → booléen, sinon texte. Aucune réinterprétation (`infer_types`) :
  un code « 00123 » reste du texte.
- Les lignes de total (`summary_rows`) ne sont pas importées.
"""

import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import pandas as pd

NUMERIC_TYPES = {"currency", "number", "percent"}
ERROR_CODES = {"#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#NUM!", "#N/A", "#CYCLE!", "#ERROR!"}
_ERROR_RE = re.compile(r"^#[A-Z0-9/]+[!?]$")


class DataflowError(ValueError):
    """Enveloppe reconnue mais inexploitable (message en français)."""


@dataclass(frozen=True)
class DataflowInfo:
    """Résumé d'un instantané : de quoi le présenter dans une liste sans l'aplatir."""

    table_id: str | None
    table_name: str
    project_name: str
    workspace_name: str
    exported_at: datetime | None
    rows: int


def is_dataflow(data: Any) -> bool:
    """Vrai si `data` est une enveloppe DataFlow (`target_system`, `schema_version`, `project.columns_schema`)."""
    if not isinstance(data, dict) or "target_system" not in data or "schema_version" not in data:
        return False
    project = data.get("project")
    return isinstance(project, dict) and isinstance(project.get("columns_schema"), list)


def is_error(value: Any) -> bool:
    """Code d'erreur de formule d'Atelier Tab (`#DIV/0!`, `#NAME?`…)."""
    return isinstance(value, str) and (value in ERROR_CODES or bool(_ERROR_RE.match(value)))


def _project(data: dict[str, Any]) -> dict[str, Any]:
    project = data.get("project")
    if not isinstance(project, dict):
        raise DataflowError("Instantané Atelier Tab invalide : bloc « project » absent.")
    return project


def _text(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _parse_datetime(value: Any) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def dataflow_info(data: dict[str, Any]) -> DataflowInfo:
    """Nom de la table, projet, espace, date d'export et nombre de lignes d'une enveloppe."""
    project = _project(data)
    source = project.get("source_table") if isinstance(project.get("source_table"), dict) else {}
    workspace = data.get("workspace") if isinstance(data.get("workspace"), dict) else {}
    records = project.get("records")
    project_name = _text(project.get("name"))
    return DataflowInfo(
        table_id=_text(source.get("id")) or None,
        table_name=_text(source.get("name")) or project_name or "Table Atelier Tab",
        project_name=project_name,
        workspace_name=_text(workspace.get("name")),
        exported_at=_parse_datetime(data.get("exported_at")),
        rows=len(records) if isinstance(records, list) else 0,
    )


def _unique(names: list[str]) -> list[str]:
    out: list[str] = []
    for name in names:
        base, candidate, n = name, name, 2
        while candidate in out:
            candidate, n = f"{base}_{n}", n + 1
        out.append(candidate)
    return out


def _as_text(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, bool):
        return "Vrai" if value else "Faux"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _column(kind: str, values: list[Any]) -> pd.Series:
    """Colonne typée selon le type Atelier Tab."""
    present = [v for v in values if v is not None]
    numeric = kind in NUMERIC_TYPES or (
        kind == "formula"
        and bool(present)
        and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in present)
    )
    if numeric:
        return pd.to_numeric(
            pd.Series([v if isinstance(v, (int, float, str)) and not isinstance(v, bool) else None for v in values]),
            errors="coerce",
        )
    if kind == "date":
        return pd.to_datetime(
            pd.Series([v if isinstance(v, str) else None for v in values]), errors="coerce", format="mixed"
        )
    if kind == "checkbox":

        def flag(v: Any) -> bool | None:
            if isinstance(v, bool):
                return v
            if isinstance(v, str) and v.strip().lower() in {"true", "vrai", "oui"}:
                return True
            if isinstance(v, str) and v.strip().lower() in {"false", "faux", "non"}:
                return False
            return None

        return pd.Series([flag(v) for v in values], dtype="boolean")
    return pd.Series([_as_text(v) for v in values], dtype="object")


def dataflow_frame(data: dict[str, Any]) -> pd.DataFrame:
    """Aplatit une enveloppe DataFlow : `_ligne`, `_id`, puis une colonne typée par champ."""
    project = _project(data)
    schema = project.get("columns_schema")
    if not isinstance(schema, list) or not schema:
        raise DataflowError("Instantané Atelier Tab sans colonne (`columns_schema` vide).")
    columns = [c for c in schema if isinstance(c, dict) and isinstance(c.get("col_letter"), str)]
    if not columns:
        raise DataflowError("Instantané Atelier Tab : aucune colonne exploitable dans `columns_schema`.")
    raw_records = project.get("records")
    records = [r for r in raw_records if isinstance(r, dict)] if isinstance(raw_records, list) else []
    records.sort(key=lambda r: r.get("row_index") if isinstance(r.get("row_index"), int) else 0)

    names = _unique(["_ligne", "_id", *[(_text(c.get("label")).strip() or c["col_letter"]) for c in columns]])
    data_columns: dict[str, pd.Series] = {
        names[0]: pd.Series([r.get("row_index") for r in records], dtype="Int64"),
        names[1]: pd.Series([_as_text(r.get("record_id")) for r in records], dtype="object"),
    }
    for name, col in zip(names[2:], columns, strict=True):
        letter = col["col_letter"]
        values: list[Any] = []
        for record in records:
            cells = record.get("values")
            cell = cells.get(letter) if isinstance(cells, dict) else None
            value = cell.get("computed") if isinstance(cell, dict) else None
            values.append(None if is_error(value) else value)
        data_columns[name] = _column(_text(col.get("type")), values)
    return pd.DataFrame(data_columns)
