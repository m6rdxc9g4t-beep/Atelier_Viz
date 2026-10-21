"""Langage de requête des visuels. Miroir TypeScript : frontend/src/types/query.ts.

Un visuel décrit CE qu'il veut (dimensions, mesures, filtres) ; le moteur DuckDB génère le SQL.
Aucune chaîne SQL ne vient du client : les champs sont validés contre le schéma du jeu de données
et les valeurs passent en paramètres liés.
"""

from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.schemas.dataset import ColumnType, Scalar

Agg = Literal["sum", "avg", "min", "max", "count", "count_distinct", "median", "calc"]
"""`calc` : mesure calculée du modèle du jeu de données (`field` = nom de la mesure)."""
DateBin = Literal["year", "quarter", "month", "week", "day"]
FilterOp = Literal["in", "not_in", "eq", "neq", "gt", "gte", "lt", "lte", "between", "contains", "is_null", "not_null"]


class Dimension(BaseModel):
    """Champ de regroupement, éventuellement tronqué à une période (dates)."""

    field: str
    bin: DateBin | None = None

    @property
    def key(self) -> str:
        return f"{self.field}|{self.bin}" if self.bin else self.field


ShowKind = Literal["ytd", "running", "prev_year", "yoy_diff", "yoy_pct", "moving_avg", "pct_total"]
"""Calculs rapides (« Afficher la valeur comme ») :
- `ytd` cumul depuis le début de l'année, `running` cumul depuis l'origine ;
- `prev_year` même période l'an dernier (N-1), `yoy_diff` écart et `yoy_pct` évolution (%) vs N-1 ;
- `moving_avg` moyenne mobile sur `window` périodes ; `pct_total` part du total (%).
Les pourcentages sont renvoyés en points (12,5 pour 12,5 %)."""
PERCENT_SHOWS: set[str] = {"yoy_pct", "pct_total"}


class ShowAs(BaseModel):
    """Calcul rapide appliqué à une mesure, selon un champ date (sauf `pct_total`)."""

    kind: ShowKind
    date: str | None = Field(default=None, description="Champ date de référence.")
    window: int = Field(default=3, ge=2, le=60, description="Périodes de la moyenne mobile.")

    @model_validator(mode="after")
    def _date_required(self) -> "ShowAs":
        if self.kind != "pct_total" and not self.date:
            raise ValueError("Ce calcul demande un champ date.")
        return self

    @property
    def suffix(self) -> str:
        return f"@{self.kind}{self.window if self.kind == 'moving_avg' else ''}"


class Measure(BaseModel):
    """Agrégat calculé ; `field` vide = nombre de lignes ; `show` = calcul rapide (cumul, N-1…)."""

    field: str | None = None
    agg: Agg = "sum"
    show: ShowAs | None = None

    @property
    def base_key(self) -> str:
        return f"{self.agg}({self.field or '*'})"

    @property
    def key(self) -> str:
        return self.base_key + (self.show.suffix if self.show else "")


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
