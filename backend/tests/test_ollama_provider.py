"""OllamaProvider testé avec un transport HTTP simulé."""

import asyncio
import json

import httpx
import pytest

from app.schemas.ai import ChatMessage
from app.services.ai import AIProviderError, OllamaProvider


def provider_with(handler: httpx.MockTransport, model: str = "llama3.2") -> OllamaProvider:
    client = httpx.AsyncClient(base_url="http://ollama.test", transport=handler)
    return OllamaProvider("http://ollama.test", model, client=client)


def test_status_detects_installed_model() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        assert req.url.path == "/api/tags"
        return httpx.Response(200, json={"models": [{"name": "llama3.2:latest"}, {"name": "mistral:7b"}]})

    status = asyncio.run(provider_with(httpx.MockTransport(handler)).status())
    assert status.available is True
    assert status.models == ["llama3.2:latest", "mistral:7b"]


def test_status_reports_missing_model() -> None:
    transport = httpx.MockTransport(lambda _: httpx.Response(200, json={"models": []}))
    status = asyncio.run(provider_with(transport).status())
    assert status.available is False
    assert "ollama pull llama3.2" in (status.detail or "")


def test_status_when_server_is_down() -> None:
    def handler(req: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=req)

    status = asyncio.run(provider_with(httpx.MockTransport(handler)).status())
    assert status.available is False
    assert "ollama serve" in (status.detail or "")


def test_chat_sends_system_prompt_and_returns_content() -> None:
    seen: dict[str, object] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen.update(json.loads(req.content))
        return httpx.Response(200, json={"message": {"role": "assistant", "content": "Salut !"}})

    provider = provider_with(httpx.MockTransport(handler))
    answer = asyncio.run(provider.chat([ChatMessage(role="user", content="Bonjour")], system="Sois bref"))

    assert answer == "Salut !"
    assert seen["stream"] is False
    assert seen["messages"][0] == {"role": "system", "content": "Sois bref"}  # type: ignore[index]


def test_chat_raises_on_http_error() -> None:
    transport = httpx.MockTransport(lambda _: httpx.Response(404, text="model not found"))
    with pytest.raises(AIProviderError, match="404"):
        asyncio.run(provider_with(transport).chat([ChatMessage(role="user", content="x")]))
