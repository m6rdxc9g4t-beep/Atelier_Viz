"""Génération de visuels par l'IA. Miroir TypeScript : frontend/src/types/builder.ts.

Le catalogue des visuels vit dans le frontend (registre) : il est transmis avec la demande,
ce qui garde une seule source de vérité. Le backend s'en sert pour le prompt ET pour valider.
"""

from typing import Any, Literal

from pydantic import BaseModel, Field

from app.schemas.ai import ProviderChoice, ProviderName
from app.schemas.dataset import ColumnType
from app.schemas.report import FieldBinding, VisualType


class RoleSpec(BaseModel):
    id: str
    label: str
    kind: Literal["dimension", "measure"]
    max: int | None = None
    required: bool = False
    types: list[ColumnType] | None = None


class OptionSpec(BaseModel):
    key: str
    type: Literal["boolean", "select", "number", "text", "textarea"]
    choices: list[str] | None = None


class VisualTypeSpec(BaseModel):
    type: VisualType
    label: str
    roles: list[RoleSpec]
    options: list[OptionSpec] = Field(default_factory=list)


class BuildRequest(BaseModel):
    """« Crée un graphique du CA par région » → visuels proposés pour le Studio."""

    prompt: str = Field(min_length=3, max_length=2000)
    dataset_id: str
    provider: ProviderChoice = "auto"
    catalog: list[VisualTypeSpec] = Field(min_length=1)
    max_visuals: int = Field(default=4, ge=1, le=6)
    existing: list[str] = Field(default_factory=list, max_length=40, description="Titres des visuels déjà sur la page.")


class ProposedVisual(BaseModel):
    type: VisualType
    title: str | None = None
    roles: dict[str, list[FieldBinding]]
    options: dict[str, Any] = Field(default_factory=dict)


class BuildResponse(BaseModel):
    visuals: list[ProposedVisual]
    explanation: str
    provider: ProviderName
    model: str
    warnings: list[str] = Field(default_factory=list, description="Corrections appliquées à la proposition de l'IA.")


class RepairRequest(BaseModel):
    """Visuels proposés plus tôt (historique du volet), revalidés avant d'être ajoutés de nouveau."""

    dataset_id: str
    catalog: list[VisualTypeSpec] = Field(min_length=1)
    visuals: list[dict[str, Any]] = Field(min_length=1, max_length=6)


class RepairedVisual(BaseModel):
    """Résultat pour un visuel : réparé (`visual`) ou écarté (`errors`)."""

    visual: ProposedVisual | None = None
    warnings: list[str] = Field(default_factory=list)
    errors: list[str] = Field(default_factory=list)


class RepairResponse(BaseModel):
    """Un résultat par visuel envoyé, dans le même ordre."""

    results: list[RepairedVisual]
