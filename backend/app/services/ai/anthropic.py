"""Fournisseur Claude via le SDK officiel `anthropic`."""

from anthropic import APIError, AsyncAnthropic

from app.schemas.ai import ChatMessage, ProviderName, ProviderStatus
from app.services.ai.base import AIProviderError


class AnthropicProvider:
    """Client de l'API Messages d'Anthropic.

    Args:
        api_key: clé API de la Console Claude ; `None` = fournisseur désactivé.
        model: identifiant du modèle (ex. claude-sonnet-5-5).
        max_tokens: limite de tokens générés par réponse.
        client: client `AsyncAnthropic` injectable (tests).
    """

    name: ProviderName = "anthropic"

    def __init__(
        self,
        api_key: str | None,
        model: str,
        max_tokens: int = 2048,
        client: AsyncAnthropic | None = None,
    ) -> None:
        self.model = model
        self.max_tokens = max_tokens
        self._client = client or (AsyncAnthropic(api_key=api_key) if api_key else None)

    @property
    def configured(self) -> bool:
        return self._client is not None

    async def status(self) -> ProviderStatus:
        """Ne fait aucun appel réseau : seule la présence d'une clé est vérifiée."""
        detail = None if self.configured else "ANTHROPIC_API_KEY absente du fichier .env"
        return ProviderStatus(name="anthropic", available=self.configured, model=self.model, detail=detail)

    async def chat(self, messages: list[ChatMessage], system: str | None = None) -> str:
        if self._client is None:
            raise AIProviderError("anthropic", "Claude n'est pas configuré (ANTHROPIC_API_KEY manquante).", 400)
        try:
            response = await self._client.messages.create(
                model=self.model,
                max_tokens=self.max_tokens,
                messages=[m.model_dump() for m in messages],
                **({"system": system} if system else {}),
            )
        except APIError as exc:
            raise AIProviderError("anthropic", f"Erreur API Claude : {exc}") from exc

        return "".join(block.text for block in response.content if block.type == "text")

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.close()
