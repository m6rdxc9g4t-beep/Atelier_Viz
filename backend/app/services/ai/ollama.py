"""Fournisseur Ollama (modèles locaux) via son API HTTP."""

from collections.abc import Callable
from typing import Any

import httpx

from app.schemas.ai import ChatMessage, ProviderName, ProviderStatus
from app.services.ai.base import AIProviderError, extract_json


class OllamaProvider:
    """Client de l'API Ollama (`/api/tags`, `/api/chat`).

    Args:
        base_url: URL du serveur Ollama, ex. http://localhost:11434.
        model: modèle utilisé pour le chat (doit être installé : `ollama pull <model>`).
        timeout: délai maximal d'une génération, en secondes.
        client: client httpx injectable (tests).
        model_choice: modèle choisi par l'utilisateur (préférences), lu à chaque appel ; None = `model`.
    """

    name: ProviderName = "ollama"

    def __init__(
        self,
        base_url: str,
        model: str,
        timeout: float = 120.0,
        client: httpx.AsyncClient | None = None,
        model_choice: Callable[[], str | None] | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.default_model = model
        self._model_choice = model_choice
        self._client = client or httpx.AsyncClient(base_url=self.base_url, timeout=timeout)

    @property
    def model(self) -> str:
        """Modèle utilisé pour le prochain appel : choix de l'utilisateur, sinon la configuration."""
        chosen = self._model_choice() if self._model_choice else None
        return chosen or self.default_model

    async def list_models(self) -> list[str]:
        """Retourne les noms des modèles installés localement."""
        try:
            response = await self._client.get("/api/tags", timeout=5.0)
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise AIProviderError(
                "ollama",
                f"Ollama injoignable sur {self.base_url} (lancez `ollama serve`) : {exc}",
            ) from exc
        payload: dict[str, Any] = response.json()
        return [m["name"] for m in payload.get("models", []) if "name" in m]

    async def status(self) -> ProviderStatus:
        """Vérifie que le serveur répond et que le modèle configuré est installé."""
        try:
            models = await self.list_models()
        except AIProviderError as exc:
            return ProviderStatus(name="ollama", available=False, model=self.model, detail=exc.message)

        model = self.model
        installed = self._is_installed(models)
        detail = None if installed else f"Modèle « {model} » absent : `ollama pull {model}`"
        return ProviderStatus(name="ollama", available=installed, model=model, detail=detail, models=models)

    async def chat(self, messages: list[ChatMessage], system: str | None = None) -> str:
        """Appelle `/api/chat` en mode non streamé."""
        return await self._chat(messages, system)

    async def chat_json(
        self, messages: list[ChatMessage], system: str | None, schema: dict[str, Any]
    ) -> dict[str, Any]:
        """Sortie structurée : Ollama contraint la génération au schéma JSON fourni (`format`)."""
        content = await self._chat(messages, system, extra={"format": schema, "options": {"temperature": 0.2}})
        return extract_json("ollama", content)

    async def _chat(self, messages: list[ChatMessage], system: str | None, extra: dict[str, Any] | None = None) -> str:
        body: dict[str, Any] = {
            "model": self.model,
            "stream": False,
            "messages": ([{"role": "system", "content": system}] if system else [])
            + [m.model_dump() for m in messages],
            **(extra or {}),
        }
        try:
            response = await self._client.post("/api/chat", json=body)
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise AIProviderError(
                "ollama", f"Ollama a répondu {exc.response.status_code} : {exc.response.text[:200]}"
            ) from exc
        except httpx.HTTPError as exc:
            raise AIProviderError("ollama", f"Ollama injoignable sur {self.base_url} : {exc}") from exc

        content = response.json().get("message", {}).get("content")
        if not isinstance(content, str):
            raise AIProviderError("ollama", "Réponse Ollama inattendue (champ message.content absent).")
        return content

    async def aclose(self) -> None:
        await self._client.aclose()

    def _is_installed(self, models: list[str]) -> bool:
        """`llama3.2` correspond à `llama3.2:latest` ; un tag explicite doit correspondre exactement."""
        model = self.model
        wanted = model if ":" in model else f"{model}:latest"
        return wanted in models or model in models
