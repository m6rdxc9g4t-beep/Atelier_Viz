"""Résumé d'une page par l'IA. Miroir TypeScript : frontend/src/types/summary.ts.

Le frontend calcule des **faits** à partir des résultats déjà affichés (totaux, premiers, évolutions…) ;
seuls ces faits partent vers l'IA, jamais les lignes du jeu de données. Le backend vérifie ensuite
que chaque nombre de la synthèse figure dans ces faits.
"""

from pydantic import BaseModel, Field

from app.schemas.ai import ProviderChoice, ProviderName
from app.schemas.report import VisualType


class VisualFacts(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    title: str = Field(max_length=200)
    type: VisualType
    facts: list[str] = Field(min_length=1, max_length=15)


class SummaryRequest(BaseModel):
    report: str = Field(max_length=200)
    page: str = Field(max_length=200)
    provider: ProviderChoice = "auto"
    filters: list[str] = Field(default_factory=list, max_length=20, description="Filtres actifs, en clair.")
    visuals: list[VisualFacts] = Field(min_length=1, max_length=30)
    max_points: int = Field(default=4, ge=2, le=6)


class SummaryPoint(BaseModel):
    text: str
    visuals: list[str] = Field(default_factory=list, description="Identifiants des visuels concernés.")


class SummaryResponse(BaseModel):
    headline: str
    points: list[SummaryPoint]
    provider: ProviderName
    model: str
    warnings: list[str] = Field(
        default_factory=list, description="Points écartés ou corrigés (chiffres non vérifiables)."
    )


class AnswerRequest(BaseModel):
    """Question en langage naturel (ou « explique cet écart »), avec les faits calculés par le frontend."""

    question: str = Field(min_length=3, max_length=500)
    provider: ProviderChoice = "auto"
    filters: list[str] = Field(default_factory=list, max_length=20, description="Filtres actifs, en clair.")
    visuals: list[VisualFacts] = Field(min_length=1, max_length=6)
    kind: str = Field(default="question", pattern=r"^(question|explain)$")


class AnswerResponse(BaseModel):
    answer: str
    provider: ProviderName
    model: str
    warnings: list[str] = Field(default_factory=list, description="Phrases écartées (chiffre non vérifiable).")
