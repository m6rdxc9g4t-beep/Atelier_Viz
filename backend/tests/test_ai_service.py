"""Règles de routage de l'AIService."""

import asyncio

import pytest

from app.schemas.ai import ChatMessage, ChatRequest
from app.services.ai import AIProviderError, AIService
from tests.conftest import FakeProvider


def make_service(
    *,
    anthropic_configured: bool = True,
    anthropic_available: bool = True,
    ollama_fails: bool = False,
    fallback: bool = False,
    online: bool = True,
) -> tuple[AIService, FakeProvider, FakeProvider]:
    ollama = FakeProvider("ollama", fail=ollama_fails)
    anthropic = FakeProvider("anthropic", configured=anthropic_configured, available=anthropic_available)
    service = AIService(ollama, anthropic, allow_cloud_fallback=fallback, is_online=lambda: online)  # type: ignore[arg-type]
    return service, ollama, anthropic


def request(**kwargs: object) -> ChatRequest:
    return ChatRequest(messages=[ChatMessage(role="user", content="Bonjour")], **kwargs)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("choice", "online", "configured", "available", "expected"),
    [
        ("ollama", True, True, True, "ollama"),
        ("anthropic", True, True, True, "anthropic"),
        # Auto = Claude si en ligne ET disponible, sinon Ollama (docs/SUITE.md §5.2), quelle que soit la tâche.
        ("auto", True, True, True, "anthropic"),
        ("auto", False, True, True, "ollama"),
        ("auto", True, False, True, "ollama"),
        ("auto", True, True, False, "ollama"),
    ],
)
def test_resolve(choice: str, online: bool, configured: bool, available: bool, expected: str) -> None:
    service, _, _ = make_service(anthropic_configured=configured, anthropic_available=available, online=online)
    assert asyncio.run(service.resolve(choice)).name == expected  # type: ignore[arg-type]


def test_explicit_claude_offline_is_403() -> None:
    service, _, anthropic = make_service(online=False)
    with pytest.raises(AIProviderError) as info:
        asyncio.run(service.chat(request(provider="anthropic")))
    assert info.value.status_code == 403 and "hors ligne" in info.value.message
    assert anthropic.calls == []


def test_auto_simple_task_uses_claude_when_online_and_available() -> None:
    service, ollama, _ = make_service()
    response = asyncio.run(service.chat(request(provider="auto", task="simple")))
    assert response.provider == "anthropic"
    assert ollama.calls == []


def test_no_silent_cloud_fallback_by_default() -> None:
    service, _, anthropic = make_service(ollama_fails=True, anthropic_available=False)
    with pytest.raises(AIProviderError):
        asyncio.run(service.chat(request(provider="auto")))
    assert anthropic.calls == []


def test_cloud_fallback_when_enabled() -> None:
    service, _, _ = make_service(ollama_fails=True, fallback=True, anthropic_available=False)
    response = asyncio.run(service.chat(request(provider="auto")))
    assert response.provider == "anthropic"
    assert response.fallback_used is True


def test_explicit_ollama_never_falls_back() -> None:
    service, _, anthropic = make_service(ollama_fails=True, fallback=True)
    with pytest.raises(AIProviderError):
        asyncio.run(service.chat(request(provider="ollama")))
    assert anthropic.calls == []
