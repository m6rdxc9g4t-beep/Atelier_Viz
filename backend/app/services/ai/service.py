"""Routeur IA : choisit Ollama ou Claude selon le mode (hors ligne / en ligne), le choix et la tâche."""

import asyncio
from collections.abc import Callable
from typing import Any

from app.schemas.ai import (
    ChatMessage,
    ChatRequest,
    ChatResponse,
    ProviderChoice,
    ProvidersResponse,
    ProviderStatus,
    TaskComplexity,
)
from app.services.ai.anthropic import AnthropicProvider
from app.services.ai.base import AIProvider, AIProviderError
from app.services.ai.claude_cli import ClaudeCliProvider
from app.services.ai.ollama import OllamaProvider

# Claude est joignable de deux façons : CLI Claude Code (abonnement) ou API (clé Console).
ClaudeProvider = AnthropicProvider | ClaudeCliProvider

OFFLINE_MESSAGE = "Mode hors ligne : activez le mode en ligne (Réglages) pour utiliser Claude."


class AIService:
    """Point d'entrée unique de l'IA pour le reste du backend.

    Règles (voir specification.md §5) :
    - mode hors ligne : Claude est désactivé, tout passe par Ollama (local) ;
    - choix explicite (`ollama` / `anthropic`) : respecté tel quel ;
    - `auto` + `complex` : Claude si en ligne et configuré, sinon Ollama ;
    - `auto` + `simple` : Ollama ;
    - repli Ollama → Claude uniquement si en ligne et `allow_cloud_fallback`.

    Args:
        is_online: fonction lue à chaque requête (le mode se change à chaud depuis l'interface).
    """

    def __init__(
        self,
        ollama: OllamaProvider,
        anthropic: ClaudeProvider,
        allow_cloud_fallback: bool = False,
        is_online: Callable[[], bool] = lambda: True,
    ) -> None:
        self.ollama = ollama
        self.anthropic = anthropic
        self.allow_cloud_fallback = allow_cloud_fallback
        self.is_online = is_online

    @property
    def claude_usable(self) -> bool:
        return self.is_online() and self.anthropic.configured

    def resolve(self, choice: ProviderChoice, task: TaskComplexity) -> AIProvider:
        """Retourne le fournisseur à utiliser pour cette requête."""
        if choice == "ollama":
            return self.ollama
        if choice == "anthropic":
            if not self.is_online():
                raise AIProviderError("anthropic", OFFLINE_MESSAGE, 403)
            return self.anthropic
        if task == "complex" and self.claude_usable:
            return self.anthropic
        return self.ollama

    async def chat(self, request: ChatRequest) -> ChatResponse:
        """Route la requête, avec repli cloud optionnel en mode `auto`."""
        provider = self.resolve(request.provider, request.task)
        try:
            content = await provider.chat(request.messages, request.system)
            return ChatResponse(provider=provider.name, model=provider.model, content=content)
        except AIProviderError:
            can_fallback = (
                request.provider == "auto"
                and provider is self.ollama
                and self.allow_cloud_fallback
                and self.claude_usable
            )
            if not can_fallback:
                raise
            content = await self.anthropic.chat(request.messages, request.system)
            return ChatResponse(provider="anthropic", model=self.anthropic.model, content=content, fallback_used=True)

    async def chat_json(
        self,
        choice: ProviderChoice,
        task: TaskComplexity,
        messages: list[ChatMessage],
        system: str | None,
        schema: dict[str, Any],
    ) -> tuple[AIProvider, dict[str, Any]]:
        """Sortie JSON structurée, mêmes règles de routage (et de repli) que `chat`."""
        provider = self.resolve(choice, task)
        try:
            return provider, await provider.chat_json(messages, system, schema)
        except AIProviderError:
            can_fallback = (
                choice == "auto" and provider is self.ollama and self.allow_cloud_fallback and self.claude_usable
            )
            if not can_fallback:
                raise
            return self.anthropic, await self.anthropic.chat_json(messages, system, schema)

    async def providers_status(self) -> ProvidersResponse:
        """État de tous les fournisseurs, vérifiés en parallèle (Claude non sollicité hors ligne)."""
        if not self.is_online():
            ollama = await self.ollama.status()
            claude = ProviderStatus(
                name="anthropic", available=False, model=self.anthropic.model, detail="Désactivé : mode hors ligne"
            )
            return ProvidersResponse(providers=[ollama, claude])
        statuses = await asyncio.gather(self.ollama.status(), self.anthropic.status())
        return ProvidersResponse(providers=list(statuses))

    async def aclose(self) -> None:
        await asyncio.gather(self.ollama.aclose(), self.anthropic.aclose())
