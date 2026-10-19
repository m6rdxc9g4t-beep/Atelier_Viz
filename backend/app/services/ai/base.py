"""Contrat commun à tous les fournisseurs IA."""

from typing import Protocol

from app.schemas.ai import ChatMessage, ProviderName, ProviderStatus


class AIProviderError(Exception):
    """Erreur côté fournisseur IA, convertie en réponse HTTP par l'application.

    Attributs:
        provider: fournisseur concerné.
        status_code: code HTTP à renvoyer (503 = indisponible, 400 = non configuré…).
    """

    def __init__(self, provider: ProviderName, message: str, status_code: int = 503) -> None:
        super().__init__(message)
        self.provider = provider
        self.message = message
        self.status_code = status_code


class AIProvider(Protocol):
    """Interface implémentée par chaque fournisseur (Ollama, Anthropic…)."""

    name: ProviderName
    model: str

    async def status(self) -> ProviderStatus:
        """Indique si le fournisseur est utilisable, sans consommer de tokens."""
        ...

    async def chat(self, messages: list[ChatMessage], system: str | None = None) -> str:
        """Envoie la conversation et retourne le texte de la réponse.

        Raises:
            AIProviderError: fournisseur injoignable, non configuré ou réponse invalide.
        """
        ...

    async def aclose(self) -> None:
        """Libère les ressources réseau."""
        ...
