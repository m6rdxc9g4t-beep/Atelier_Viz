"""Fixtures partagées : application de test et faux fournisseurs IA (aucun appel réseau)."""

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.api.deps import get_ai_service
from app.core.config import Settings
from app.schemas.ai import ChatMessage, ProviderName, ProviderStatus
from app.services.ai import AIProviderError
from main import create_app


class FakeProvider:
    """Fournisseur simulé : renvoie une réponse fixe ou lève une erreur."""

    def __init__(self, name: ProviderName, *, configured: bool = True, fail: bool = False) -> None:
        self.name: ProviderName = name
        self.model = f"{name}-test"
        self.configured = configured
        self.fail = fail
        self.calls: list[list[ChatMessage]] = []

    async def status(self) -> ProviderStatus:
        return ProviderStatus(name=self.name, available=self.configured and not self.fail, model=self.model)

    async def chat(self, messages: list[ChatMessage], system: str | None = None) -> str:
        self.calls.append(messages)
        if self.fail:
            raise AIProviderError(self.name, f"{self.name} indisponible")
        return f"réponse de {self.name}"

    async def aclose(self) -> None:
        return None


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    # Mode "api" sans clé : aucun test ne lance la vraie CLI ni n'appelle l'API.
    # data_dir temporaire : chaque test a sa propre base DuckDB et ses propres rapports.
    return Settings(  # type: ignore[call-arg]
        app_env="test",
        claude_mode="api",
        anthropic_api_key=None,
        data_dir=tmp_path,
        secrets_backend="file",  # jamais le trousseau réel du développeur
        _env_file=None,
    )


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(settings)) as test_client:
        yield test_client


@pytest.fixture
def override_ai(client: TestClient):
    """Permet à un test de remplacer l'AIService par une version simulée."""

    def _override(service: object) -> None:
        client.app.dependency_overrides[get_ai_service] = lambda: service  # type: ignore[attr-defined]

    yield _override
    client.app.dependency_overrides.clear()  # type: ignore[attr-defined]
