"""Endpoints /api/ai/*."""

from fastapi.testclient import TestClient

from app.services.ai import AIService
from tests.conftest import FakeProvider


def test_providers_lists_both(client: TestClient, override_ai) -> None:
    override_ai(AIService(FakeProvider("ollama"), FakeProvider("anthropic", configured=False)))  # type: ignore[arg-type]
    response = client.get("/api/ai/providers")
    assert response.status_code == 200
    by_name = {p["name"]: p for p in response.json()["providers"]}
    assert by_name["ollama"]["available"] is True
    assert by_name["anthropic"]["available"] is False


def test_chat_routes_to_ollama(client: TestClient, override_ai) -> None:
    override_ai(AIService(FakeProvider("ollama"), FakeProvider("anthropic")))  # type: ignore[arg-type]
    response = client.post(
        "/api/ai/chat",
        json={"messages": [{"role": "user", "content": "Bonjour"}], "provider": "ollama"},
    )
    assert response.status_code == 200
    assert response.json() == {
        "provider": "ollama",
        "model": "ollama-test",
        "content": "réponse de ollama",
        "fallback_used": False,
    }


def test_chat_provider_error_becomes_503(client: TestClient, override_ai) -> None:
    override_ai(AIService(FakeProvider("ollama", fail=True), FakeProvider("anthropic")))  # type: ignore[arg-type]
    response = client.post(
        "/api/ai/chat", json={"messages": [{"role": "user", "content": "Bonjour"}], "provider": "ollama"}
    )
    assert response.status_code == 503
    assert response.json()["provider"] == "ollama"


def test_chat_rejects_empty_messages(client: TestClient) -> None:
    response = client.post("/api/ai/chat", json={"messages": []})
    assert response.status_code == 422


def test_claude_blocked_when_offline(client: TestClient) -> None:
    # Par défaut l'application est hors ligne : Claude refuse avant toute tentative.
    response = client.post(
        "/api/ai/chat",
        json={"messages": [{"role": "user", "content": "Bonjour"}], "provider": "anthropic"},
    )
    assert response.status_code == 403
    assert "hors ligne" in response.json()["detail"]
    claude = next(p for p in client.get("/api/ai/providers").json()["providers"] if p["name"] == "anthropic")
    assert claude["available"] is False and "hors ligne" in claude["detail"]


def test_anthropic_without_key_returns_400(client: TestClient) -> None:
    # Application réelle (pas d'override), mode en ligne, mais sans clé API.
    assert client.put("/api/settings", json={"online_mode": True}).json()["online_mode"] is True
    response = client.post(
        "/api/ai/chat",
        json={"messages": [{"role": "user", "content": "Bonjour"}], "provider": "anthropic"},
    )
    assert response.status_code == 400
    assert "ANTHROPIC_API_KEY" in response.json()["detail"]


def test_providers_refresh_forgets_cached_claude_state(client: TestClient, override_ai) -> None:
    claude = FakeProvider("anthropic")
    claude.invalidated = 0  # type: ignore[attr-defined]

    def invalidate() -> None:
        claude.invalidated += 1  # type: ignore[attr-defined]

    claude.invalidate = invalidate  # type: ignore[attr-defined]
    override_ai(AIService(FakeProvider("ollama"), claude))  # type: ignore[arg-type]
    assert client.get("/api/ai/providers").status_code == 200
    assert claude.invalidated == 0  # type: ignore[attr-defined]
    assert client.get("/api/ai/providers?refresh=true").status_code == 200
    assert claude.invalidated == 1  # type: ignore[attr-defined]


def test_models_follow_preferences(client: TestClient) -> None:
    """Le modèle choisi dans l'interface est celui des appels (application réelle, mode API en test)."""
    service = client.app.state.ai_service  # type: ignore[attr-defined]
    assert service.ollama.model == "llama3.2"
    client.put("/api/settings", json={"ollama_model": "qwen3:8b"})
    assert service.ollama.model == "qwen3:8b"
    client.put("/api/settings", json={"ollama_model": None})
    assert service.ollama.model == "llama3.2"
