"""Configuration de l'application, lue depuis les variables d'environnement et `.env`."""

from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Paramètres globaux. Chaque champ correspond à une variable d'environnement en MAJUSCULES."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "Atelier Viz API"
    app_env: Literal["development", "test", "production"] = "development"
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:5173"])

    # Ollama (local)
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "llama3.2"
    ollama_timeout_seconds: float = 120.0

    # Claude : "cli" = CLI Claude Code (abonnement claude.ai), "api" = API Anthropic (clé Console)
    claude_mode: Literal["cli", "api"] = "cli"
    claude_cli_path: str = "claude"
    claude_cli_model: str = "sonnet"
    claude_cli_timeout_seconds: float = 180.0

    # Claude (API Anthropic, si claude_mode = "api")
    anthropic_api_key: SecretStr | None = None
    anthropic_model: str = "claude-sonnet-5-5"
    anthropic_max_tokens: int = 2048

    # Routage IA
    ai_allow_cloud_fallback: bool = False

    # Données locales : base DuckDB, rapports JSON, préférences (tout reste sur la machine)
    data_dir: Path = Path("data")
    max_upload_mb: int = 50

    # GitHub (jalon 2)
    github_token: SecretStr | None = None

    @property
    def anthropic_configured(self) -> bool:
        """Vrai si une clé API Anthropic non vide est disponible."""
        return bool(self.anthropic_api_key and self.anthropic_api_key.get_secret_value().strip())


@lru_cache
def get_settings() -> Settings:
    """Retourne l'instance unique (mise en cache) des paramètres."""
    return Settings()
