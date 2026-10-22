"""Configuration de l'application, lue depuis les variables d'environnement et `.env`."""

import json
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import AliasChoices, Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    """Paramètres globaux. Chaque champ correspond à une variable d'environnement en MAJUSCULES."""

    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore", populate_by_name=True
    )

    app_name: str = "Atelier Viz API"
    app_env: Literal["development", "test", "production"] = "development"
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:5173"])
    # Garde « requêtes locales » (docs/SUITE.md §5.1, app/core/local_only.py) : hôtes acceptés en plus de
    # 127.0.0.1, localhost et [::1]. Liste séparée par des virgules : ALLOWED_HOSTS=viz.local,autre.local
    allowed_hosts: Annotated[list[str], NoDecode] = Field(default_factory=list)

    # Ollama (local)
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "llama3.2"
    ollama_timeout_seconds: float = 120.0

    # Claude : "cli" = CLI Claude Code (abonnement claude.ai), "api" = API Anthropic (clé Console)
    claude_mode: Literal["cli", "api"] = "cli"
    # Exécutable : CLAUDE_CLI (docs/SUITE.md §5.3) ou CLAUDE_CLI_PATH ;
    # sinon PATH, ~/.local/bin, /opt/homebrew/bin, /usr/local/bin
    claude_cli_path: str = Field(
        default="claude", validation_alias=AliasChoices("claude_cli", "claude_cli_path")
    )
    # Modèle par défaut ; l'utilisateur choisit Sonnet / Opus / Haiku dans l'interface (préférences)
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
    # Interface compilée (npm run build) servie par l'API : une seule adresse, utilisée par l'application de bureau.
    frontend_dist: Path = Path(__file__).resolve().parents[3] / "frontend" / "dist"
    serve_frontend: bool = True
    # Jeux d'exemple livrés avec le dépôt (bouton « Charger l'exemple »)
    samples_dir: Path = Path(__file__).resolve().parents[3] / "samples"

    # Connecteurs (SQL Server, PostgreSQL, MySQL, SQLite, fichiers, SharePoint)
    secrets_backend: Literal["auto", "keyring", "file"] = "auto"  # trousseau système, sinon data/secrets.json (0600)
    connector_login_timeout_seconds: float = 15.0
    connector_query_timeout_seconds: float = 300.0
    connector_max_rows: int = 2_000_000
    connector_max_file_mb: int = 500
    # SharePoint Online : application Entra ID (client public, Sites.Read.All + Files.Read.All déléguées)
    sharepoint_client_id: str | None = None
    sharepoint_tenant: str = "organizations"
    # Suite Atelier (docs/SUITE.md §4) : instantanés d'Atelier Tab, API locale d'Atelier Projets
    atelier_tab_exports_dir: Path = Path("~/Atelier_Tab/exports")
    # Taille maximale d'un instantané d'Atelier Tab (JSON entièrement chargé en mémoire : ~10 à 20 × sa taille).
    atelier_tab_max_snapshot_mb: int = Field(default=50, ge=1, le=2000)
    atelier_projets_url: str = "http://127.0.0.1:3000"
    atelier_projets_timeout_seconds: float = 30.0

    # Actualisation planifiée et alertes (data/schedules.json, data/alerts.json)
    scheduler_enabled: bool = True
    # Notifications système (centre de notifications macOS, notify-send sous Linux) au déclenchement d'une alerte.
    system_notifications: bool = True
    scheduler_period_seconds: float = Field(default=15.0, ge=1.0)
    # Arrêt : délai laissé aux actualisations en cours avant la fermeture de DuckDB
    scheduler_shutdown_seconds: float = Field(default=10.0, ge=0.0, le=300.0)

    # Nœud Atelier (docs/SUITE.md §7) : enregistrements d'un même rapport regroupés en un événement
    # `viz.report.saved` s'ils sont rapprochés de moins de N secondes (le Studio enregistre en continu ; 0 = immédiat).
    atelier_report_event_seconds: float = Field(default=5.0, ge=0.0, le=600.0)

    # GitHub : synchronisation des rapports (jeton de repli ; d'ordinaire saisi dans l'interface → trousseau)
    github_token: SecretStr | None = None

    @field_validator("allowed_hosts", mode="before")
    @classmethod
    def _split_hosts(cls, value: Any) -> Any:
        """`ALLOWED_HOSTS` : « a,b » ou liste JSON « ["a","b"] »."""
        if isinstance(value, str):
            text = value.strip()
            if text.startswith("["):
                return json.loads(text)
            return [h.strip() for h in text.split(",") if h.strip()]
        return value

    @property
    def anthropic_configured(self) -> bool:
        """Vrai si une clé API Anthropic non vide est disponible."""
        return bool(self.anthropic_api_key and self.anthropic_api_key.get_secret_value().strip())


@lru_cache
def get_settings() -> Settings:
    """Retourne l'instance unique (mise en cache) des paramètres."""
    return Settings()
