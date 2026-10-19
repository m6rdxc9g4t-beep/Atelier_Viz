"""Schémas Pydantic de l'assistant IA. Miroir TypeScript : frontend/src/types/ai.ts."""

from typing import Literal

from pydantic import BaseModel, Field

ProviderName = Literal["ollama", "anthropic"]
ProviderChoice = Literal["auto", "ollama", "anthropic"]
TaskComplexity = Literal["simple", "complex"]


class ChatMessage(BaseModel):
    """Un message de la conversation."""

    role: Literal["user", "assistant"]
    content: str = Field(min_length=1)


class ChatRequest(BaseModel):
    """Requête de chat envoyée à l'assistant."""

    messages: list[ChatMessage] = Field(min_length=1)
    system: str | None = Field(default=None, description="Consigne système optionnelle.")
    provider: ProviderChoice = "auto"
    task: TaskComplexity = Field(
        default="simple",
        description="Utilisé en mode 'auto' : 'complex' privilégie Claude.",
    )
    dataset_id: str | None = Field(
        default=None, description="Jeu de données dont le schéma et un échantillon sont fournis à l'IA."
    )


class ChatResponse(BaseModel):
    """Réponse de l'assistant, avec le fournisseur effectivement utilisé."""

    provider: ProviderName
    model: str
    content: str
    fallback_used: bool = False


class ProviderStatus(BaseModel):
    """État d'un fournisseur IA."""

    name: ProviderName
    available: bool
    model: str
    detail: str | None = None
    models: list[str] = Field(default_factory=list, description="Modèles installés (Ollama).")


class ProvidersResponse(BaseModel):
    """État de l'ensemble des fournisseurs."""

    providers: list[ProviderStatus]
