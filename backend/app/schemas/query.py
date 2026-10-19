"""Langage de requête des visuels. Miroir TypeScript : frontend/src/types/query.ts.

Un visuel décrit CE qu'il veut (dimensions, mesures, filtres) ; le moteur DuckDB génère le SQL.
Aucune chaîne SQL ne vient du client : les champs sont validés contre le schéma du jeu de données
et les valeurs passent en paramètres liés.
"""

from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.schemas.dataset import ColumnType, Scalar

Agg = Literal["sum", "avg", "min", "max", "count", "count_distinct", "median"]
DateBin = Literal["year", "quarter", "month", "week", "day"]
FilterOp = Literal["in", "not_in", "eq", "neq", "gt", "gte", "lt", "lte", "between", "contains", "is_null", "not_null"]


class Dimension(BaseModel):
    """Champ de regroupement, éventuellement tronqué à une période (dates)."""

    field: str
    bin: DateBin | None = None

    @property
    def key(self) -> str:
        return f"{self.field}|{self.bin}" if self.bin else self.field


class Measure(BaseModel):
    """Agrégat calculé ; `field` vide = nombre de lignes."""

    field: str | None = None
    agg: Agg = "sum"

    @property
    def key(self) -> str:
        return f"{self.agg}({self.field or '*'})"


class Filter(BaseModel):
    """Condition sur un champ (ou sur sa période si `bin` est fourni)."""

    field: str
    op: FilterOp = "in"
    values: list[Scalar] = Field(default_factory=list)
    bin: DateBin | None = None

    @model_validator(mode="after")
    def _check_arity(self) -> "Filter":
        if self.op == "between" and len(self.values) != 2:
            raise ValueError("Le filtre « between » attend exactement deux valeurs (min, max).")
        if self.op in {"eq", "neq", "gt", "gte", "lt", "lte", "contains"} and len(self.values) != 1:
            raise ValueError(f"Le filtre « {self.op} » attend exactement une valeur.")
        return self


class Sort(BaseModel):
    key: str
    desc: bool = False


class QueryRequest(BaseModel):
    """Requête d'agrégation sur un jeu de données."""

    dataset_id: str
    dimensions: list[Dimension] = Field(default_factory=list, max_length=8)
    measures: list[Measure] = Field(default_factory=list, max_length=12)
    filters: list[Filter] = Field(default_factory=list)
    sort: list[Sort] = Field(default_factory=list)
    limit: int = Field(default=5000, ge=1, le=50_000)
    grouping_sets: list[list[str]] | None = Field(
        default=None,
        description="Clés de dimensions par ensemble (sous-totaux des matrices). Ajoute la colonne __grouping.",
    )

    @model_validator(mode="after")
    def _not_empty(self) -> "QueryRequest":
        if not self.dimensions and not self.measures:
            raise ValueError("Une requête doit contenir au moins une dimension ou une mesure.")
        return self


class QueryColumn(BaseModel):
    key: str
    field: str | None
    role: Literal["dimension", "measure", "grouping"]
    type: ColumnType


class QueryResponse(BaseModel):
    """Résultat tabulaire compact : colonnes + lignes sous forme de listes."""

    columns: list[QueryColumn]
    rows: list[list[Scalar]]
    truncated: bool = False
