"""Couche IA hybride : un contrat commun (`AIProvider`) et un routeur (`AIService`)."""

from app.services.ai.anthropic import AnthropicProvider
from app.services.ai.base import AIProvider, AIProviderError
from app.services.ai.claude_cli import ClaudeCliProvider
from app.services.ai.ollama import OllamaProvider
from app.services.ai.service import AIService

__all__ = [
    "AIProvider",
    "AIProviderError",
    "AIService",
    "AnthropicProvider",
    "ClaudeCliProvider",
    "OllamaProvider",
]
