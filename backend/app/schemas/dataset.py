"""Schémas des jeux de données importés. Miroir TypeScript : frontend/src/types/dataset.ts."""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

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


class DatasetRows(BaseModel):
    """Page de lignes d'un jeu de données."""

    columns: list[str]
    rows: list[dict[str, Any]]
    total: int
    offset: int
    limit: int
