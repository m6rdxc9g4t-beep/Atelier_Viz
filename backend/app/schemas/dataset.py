"""Schémas des jeux de données importés. Miroir TypeScript : frontend/src/types/dataset.ts."""

import unicodedata
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

ColumnType = Literal["number", "string", "date", "boolean"]
SourceFormat = Literal["csv", "xlsx", "json"]
Scalar = float | int | str | bool | None


class ValueCount(BaseModel):
    """Une valeur fréquente et son nombre d'occurrences."""

    value: str
    count: int


class ColumnProfile(BaseModel):
    """Profil statistique d'une colonne."""

    name: str
    type: ColumnType
    nulls: int = Field(description="Nombre de valeurs manquantes.")
    distinct: int = Field(description="Nombre de valeurs distinctes (hors manquantes).")
    min: Scalar = None
    max: Scalar = None
    mean: float | None = Field(default=None, description="Moyenne (colonnes numériques).")
    top_values: list[ValueCount] = Field(default_factory=list, description="Valeurs les plus fréquentes.")
    calculated: bool = Field(default=False, description="Colonne calculée (définie dans le modèle).")
    expression: str | None = Field(default=None, description="Expression d'une colonne calculée.")


FORBIDDEN_NAME_CHARS = set('|[]"\n\r\t')


def _check_name(name: str) -> str:
    name = name.strip()
    if not name:
        raise ValueError("Le nom est obligatoire.")
    if FORBIDDEN_NAME_CHARS & set(name) or name.startswith("__"):
        raise ValueError('Le nom ne peut pas contenir | [ ] " ni commencer par « __ ».')
    # Caractères de contrôle et de mise en forme invisibles (NUL, inversion de sens RLO…).
    if any(unicodedata.category(c) in {"Cc", "Cf"} for c in name):
        raise ValueError("Le nom contient un caractère invisible ou de contrôle.")
    return name


class CalculatedColumn(BaseModel):
    """Colonne calculée ligne à ligne (ex. `prix_unitaire * 1.2`)."""

    name: str = Field(min_length=1, max_length=80)
    expression: str = Field(min_length=1, max_length=2000)

    _name = field_validator("name")(_check_name)


class CalculatedMeasure(BaseModel):
    """Mesure calculée à partir d'agrégats (ex. `SUM(ca) - SUM(cout)`)."""

    name: str = Field(min_length=1, max_length=80)
    expression: str = Field(min_length=1, max_length=2000)
    description: str | None = Field(default=None, max_length=300)

    _name = field_validator("name")(_check_name)


class DatasetModel(BaseModel):
    """Modèle d'un jeu de données : colonnes et mesures calculées (évaluées par DuckDB)."""

    columns: list[CalculatedColumn] = Field(default_factory=list, max_length=50)
    measures: list[CalculatedMeasure] = Field(default_factory=list, max_length=100)


class DatasetSummary(BaseModel):
    """Résumé d'un jeu de données (liste)."""

    id: str
    name: str
    format: SourceFormat
    rows: int
    columns_count: int
    created_at: datetime


class DatasetProfile(DatasetSummary):
    """Jeu de données profilé : colonnes typées + échantillon."""

    columns: list[ColumnProfile]
    sample: list[dict[str, Any]] = Field(description="Premières lignes, valeurs sérialisées en JSON.")
    model: DatasetModel = Field(default_factory=DatasetModel, description="Colonnes et mesures calculées.")


class DatasetRows(BaseModel):
    """Page de lignes d'un jeu de données."""

    columns: list[str]
    rows: list[dict[str, Any]]
    total: int
    offset: int
    limit: int


class ExpressionCheck(BaseModel):
    """Vérification d'une expression dans l'éditeur (avant enregistrement)."""

    kind: Literal["column", "measure"]
    name: str = Field(default="", max_length=80)
    expression: str = Field(max_length=2000)


class ExpressionResult(BaseModel):
    ok: bool
    type: ColumnType | None = None
    error: str | None = None
    position: int | None = Field(default=None, description="Index du caractère fautif.")
    preview: list[Scalar] = Field(default_factory=list, description="5 premières valeurs (colonne) ou total (mesure).")


class ModelIssue(BaseModel):
    kind: Literal["column", "measure"]
    name: str
    error: str
    position: int | None = None
