"""Règles de routage de l'AIService."""

import asyncio

import pytest

from app.schemas.ai import ChatMessage, ChatRequest
from app.services.ai import AIProviderError, AIService
from tests.conftest import FakeProvider


def make_service(
    *, anthropic_configured: bool = True, ollama_fails: bool = False, fallback: bool = False
) -> tuple[AIService, FakeProvider, FakeProvider]:
    ollama = FakeProvider("ollama", fail=ollama_fails)
    anthropic = FakeProvider("anthropic", configured=anthropic_configured)
    service = AIService(ollama, anthropic, allow_cloud_fallback=fallback)  # type: ignore[arg-type]
    return service, ollama, anthropic


def request(**kwargs: object) -> ChatRequest:
    return ChatRequest(messages=[ChatMessage(role="user", content="Bonjour")], **kwargs)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    ("choice", "task", "configured", "expected"),
    [
        ("ollama", "complex", True, "ollama"),
        ("anthropic", "simple", True, "anthropic"),
        ("auto", "simple", True, "ollama"),
        ("auto", "complex", True, "anthropic"),
        ("auto", "complex", False, "ollama"),
    ],
)
def test_resolve(choice: str, task: str, configured: bool, expected: str) -> None:
    service, _, _ = make_service(anthropic_configured=configured)
    assert service.resolve(choice, task).name == expected  # type: ignore[arg-type]


def test_no_silent_cloud_fallback_by_default() -> None:
    service, _, anthropic = make_service(ollama_fails=True)
    with pytest.raises(AIProviderError):
        asyncio.run(service.chat(request(provider="auto")))
    assert anthropic.calls == []


def test_cloud_fallback_when_enabled() -> None:
    service, _, _ = make_service(ollama_fails=True, fallback=True)
    response = asyncio.run(service.chat(request(provider="auto")))
    assert response.provider == "anthropic"
    assert response.fallback_used is True


def test_explicit_ollama_never_falls_back() -> None:
    service, _, anthropic = make_service(ollama_fails=True, fallback=True)
    with pytest.raises(AIProviderError):
        asyncio.run(service.chat(request(provider="ollama")))
    assert anthropic.calls == []
