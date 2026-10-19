"""Modèle d'un rapport (fichier JSON). Miroir TypeScript : frontend/src/types/report.ts.

Le backend valide la structure (pages, visuels, positions, liaisons de champs) mais laisse
`options` libre : chaque type de visuel définit ses propres options côté frontend.
"""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.schemas.query import Agg, DateBin, Filter

VisualType = Literal[
    # Graphiques
    "bar",
    "column",
    "line",
    "area",
    "combo",
    "pie",
    "donut",
    "scatter",
    "treemap",
    "funnel",
    "radar",
    "waterfall",
    "gauge",
    "heatmap",
    # Données tabulaires et indicateurs
    "kpi",
    "table",
    "matrix",
    # Cartes géographiques
    "map",
    "pointmap",
    # Interactivité et mise en page
    "slicer",
    "button",
    "text",
]


class FieldBinding(BaseModel):
    """Champ placé dans un rôle d'un visuel (Axe, Valeurs, Légende…)."""

    field: str
    agg: Agg | None = Field(default=None, description="Agrégation (mesures). None = dimension.")
    bin: DateBin | None = Field(default=None, description="Période pour les dates.")
    label: str | None = None


class Layout(BaseModel):
    """Position sur la grille de 24 colonnes."""

    x: int = Field(ge=0)
    y: int = Field(ge=0)
    w: int = Field(ge=1, le=24)
    h: int = Field(ge=1)


class Visual(BaseModel):
    id: str
    type: VisualType
    title: str | None = None
    layout: Layout
    dataset_id: str | None = None
    roles: dict[str, list[FieldBinding]] = Field(default_factory=dict)
    options: dict[str, Any] = Field(default_factory=dict)
    filters: list[Filter] = Field(default_factory=list, description="Filtres propres à ce visuel.")


class Page(BaseModel):
    id: str
    name: str
    visuals: list[Visual] = Field(default_factory=list)
    filters: list[Filter] = Field(default_factory=list, description="Filtres appliqués à toute la page.")


class ReportBody(BaseModel):
    """Contenu modifiable d'un rapport."""

    name: str = Field(min_length=1, max_length=200)
    dataset_id: str | None = Field(default=None, description="Jeu de données par défaut des nouveaux visuels.")
    pages: list[Page] = Field(default_factory=list)
    theme: dict[str, Any] = Field(default_factory=dict)


class Report(ReportBody):
    id: str
    version: Literal[1] = 1
    created_at: datetime
    updated_at: datetime


class ReportSummary(BaseModel):
    id: str
    name: str
    pages: int
    visuals: int
    updated_at: datetime


class ReportCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    dataset_id: str | None = None
