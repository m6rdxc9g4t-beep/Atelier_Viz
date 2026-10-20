"""Contrat commun à tous les fournisseurs IA."""

import json
from typing import Any, Protocol

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

    async def chat_json(
        self, messages: list[ChatMessage], system: str | None, schema: dict[str, Any]
    ) -> dict[str, Any]:
        """Comme `chat`, mais la réponse est un objet JSON conforme (autant que possible) à `schema`.

        Raises:
            AIProviderError: fournisseur indisponible ou réponse non JSON.
        """
        ...

    async def aclose(self) -> None:
        """Libère les ressources réseau."""
        ...


def extract_json(provider: ProviderName, text: str) -> dict[str, Any]:
    """Extrait le premier objet JSON d'une réponse (tolère un bloc ```json … ``` ou du texte autour)."""
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`")
        cleaned = cleaned[cleaned.find("{") :] if "{" in cleaned else cleaned
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start == -1 or end <= start:
        raise AIProviderError(provider, "La réponse de l'IA ne contient pas d'objet JSON.", 502)
    try:
        data = json.loads(cleaned[start : end + 1])
    except json.JSONDecodeError as exc:
        raise AIProviderError(provider, f"JSON invalide renvoyé par l'IA : {exc.msg}.", 502) from exc
    if not isinstance(data, dict):
        raise AIProviderError(provider, "La réponse JSON de l'IA n'est pas un objet.", 502)
    return data


DATA_ENUM = "x-atelier-donnees"
"""Marque d'un sous-schéma dont l'`enum` vient des données (noms de colonnes, par exemple).

Ollama et l'API reçoivent ce schéma tel quel (sans la marque) : la génération est contrainte aux valeurs.
La CLI Claude, elle, reçoit le schéma **en argument** de ligne de commande (`--json-schema`, visible par `ps`) :
ces énumérations y sont retirées (docs/SUITE.md §5.3, « aucune donnée en argument ») ; les valeurs voyagent
dans la conversation (entrée standard) et la réponse est de toute façon revalidée en aval (`repair`).
"""


def schema_for_model(schema: Any, *, keep_data: bool = True) -> Any:
    """Copie de `schema` sans la marque `DATA_ENUM` ; avec `keep_data=False`, sans les `enum` marqués non plus."""
    if isinstance(schema, list):
        return [schema_for_model(item, keep_data=keep_data) for item in schema]
    if not isinstance(schema, dict):
        return schema
    marked = schema.get(DATA_ENUM) is True
    return {
        key: schema_for_model(value, keep_data=keep_data)
        for key, value in schema.items()
        if key != DATA_ENUM and not (marked and not keep_data and key == "enum")
    }
