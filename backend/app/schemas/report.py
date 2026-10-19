"""Modèle d'un rapport (fichier JSON). Miroir TypeScript : frontend/src/types/report.ts.

Le backend valide la structure (pages, visuels, positions, liaisons de champs) mais laisse
`options` libre : chaque type de visuel définit ses propres options côté frontend.
"""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator

from app.schemas.dataset import Scalar
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
    """Position d'un visuel.

    En pixels de page quand la page a une taille (`Page.size`, placement libre) ; sinon, anciens
    rapports, en cases de la grille de 24 colonnes (converties en pixels à l'ouverture dans le Studio).
    """

    x: int = Field(ge=0, le=20000)
    y: int = Field(ge=0, le=40000)
    w: int = Field(ge=1, le=20000)
    h: int = Field(ge=1, le=40000)


class PageSize(BaseModel):
    """Taille de la page en pixels (16:9 = 1280 × 720, comme Power BI)."""

    width: int = Field(default=1280, ge=320, le=8000)
    height: int = Field(default=720, ge=240, le=40000)


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
    size: PageSize | None = Field(
        default=None, description="Taille en pixels (placement libre) ; absent = ancienne grille."
    )


class BookmarkVisualState(BaseModel):
    """État d'un visuel capturé par un signet : sélection d'un segment, niveau d'exploration."""

    selected: list[Scalar] | None = Field(default=None, description="Segment : valeurs cochées.")
    range: list[Scalar] | None = Field(default=None, max_length=2, description="Segment « plage » : [min, max].")
    drill: dict[str, Any] | None = Field(
        default=None, description="Exploration (`options.drill`) ; absent = niveau supérieur."
    )


class BookmarkPageState(BaseModel):
    """Filtres de la page et état de ses visuels au moment de la capture."""

    filters: list[Filter] = Field(default_factory=list)
    visuals: dict[str, BookmarkVisualState] = Field(default_factory=dict)


class BookmarkSelection(BaseModel):
    """Filtrage croisé (clic dans un visuel) capturé par un signet."""

    visual_id: str
    dataset_id: str
    filters: list[Filter] = Field(default_factory=list)
    keys: list[str] = Field(default_factory=list)


class Bookmark(BaseModel):
    """Signet : état nommé d'un rapport (page active, filtres, segments, exploration), comme dans Power BI."""

    id: str = Field(min_length=1, max_length=40)
    name: str = Field(min_length=1, max_length=80)
    page_id: str | None = Field(default=None, description="Page affichée lors de la capture.")
    apply_page: bool = Field(default=True, description="Appliquer : revenir à la page capturée.")
    apply_data: bool = Field(default=True, description="Appliquer : filtres, segments, sélection, exploration.")
    pages: dict[str, BookmarkPageState] = Field(default_factory=dict, description="État par identifiant de page.")
    selection: BookmarkSelection | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class ReportBody(BaseModel):
    """Contenu modifiable d'un rapport."""

    name: str = Field(min_length=1, max_length=200)
    dataset_id: str | None = Field(default=None, description="Jeu de données par défaut des nouveaux visuels.")
    pages: list[Page] = Field(default_factory=list)
    theme: dict[str, Any] = Field(default_factory=dict)
    # Absent des rapports antérieurs au jalon 6 : liste vide à la lecture (migration tolérante).
    bookmarks: list[Bookmark] = Field(default_factory=list, max_length=100)

    @model_validator(mode="after")
    def _unique_bookmarks(self) -> "ReportBody":
        ids = [b.id for b in self.bookmarks]
        if len(ids) != len(set(ids)):
            raise ValueError("Deux signets ont le même identifiant.")
        return self


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
    bookmarks: int = 0
    updated_at: datetime


class ReportCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    dataset_id: str | None = None
