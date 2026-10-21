"""Dépendances FastAPI partagées par les routes."""

from collections.abc import Callable
from typing import Annotated

from fastapi import Depends, Request

from app.core.config import Settings
from app.services.ai import AIService, AnthropicProvider, ClaudeCliProvider, OllamaProvider
from app.services.ai.service import ClaudeProvider
from app.services.alerts import AlertService
from app.services.atelier import AtelierService, EventJournal, IdempotencyStore
from app.services.connectors import ConnectionService
from app.services.data import DatasetStore
from app.services.engine import LocalDatabase
from app.services.github import GitHubSync
from app.services.preferences import Preferences, PreferencesStore
from app.services.refresh import RefreshScheduler
from app.services.reports import ReportRepository


def build_claude_provider(
    settings: Settings, preferences: Callable[[], Preferences] | None = None
) -> ClaudeProvider:
    """CLI Claude Code (abonnement) ou API Anthropic (clé Console), selon `CLAUDE_MODE`.

    En mode CLI, le modèle (Sonnet / Opus / Haiku) est celui choisi par l'utilisateur (`preferences`).
    """
    if settings.claude_mode == "cli":
        return ClaudeCliProvider(
            executable=settings.claude_cli_path,
            model=settings.claude_cli_model,
            timeout=settings.claude_cli_timeout_seconds,
            model_choice=(lambda: preferences().claude_model) if preferences else None,
        )
    api_key = settings.anthropic_api_key.get_secret_value() if settings.anthropic_configured else None
    return AnthropicProvider(
        api_key=api_key,
        model=settings.anthropic_model,
        max_tokens=settings.anthropic_max_tokens,
    )


def build_ai_service(
    settings: Settings,
    is_online: Callable[[], bool] = lambda: True,
    preferences: Callable[[], Preferences] | None = None,
) -> AIService:
    """Construit l'`AIService` à partir de la configuration (et des modèles choisis dans `preferences`)."""
    return AIService(
        ollama=OllamaProvider(
            base_url=settings.ollama_base_url,
            model=settings.ollama_model,
            timeout=settings.ollama_timeout_seconds,
            model_choice=(lambda: preferences().ollama_model) if preferences else None,
        ),
        anthropic=build_claude_provider(settings, preferences),
        allow_cloud_fallback=settings.ai_allow_cloud_fallback,
        is_online=is_online,
    )


def get_app_settings(request: Request) -> Settings:
    """Retourne la configuration avec laquelle l'application a été créée."""
    settings: Settings = request.app.state.settings
    return settings


def get_ai_service(request: Request) -> AIService:
    """Retourne l'instance créée au démarrage de l'application (voir `lifespan`)."""
    service: AIService = request.app.state.ai_service
    return service


def get_database(request: Request) -> LocalDatabase:
    db: LocalDatabase = request.app.state.database
    return db


def get_dataset_store(request: Request) -> DatasetStore:
    """Jeux de données persistés dans la base DuckDB locale."""
    store: DatasetStore = request.app.state.dataset_store
    return store


def get_report_repository(request: Request) -> ReportRepository:
    repo: ReportRepository = request.app.state.reports
    return repo


def get_preferences(request: Request) -> PreferencesStore:
    prefs: PreferencesStore = request.app.state.preferences
    return prefs


def get_connections(request: Request) -> ConnectionService:
    """Connexions aux sources externes."""
    service: ConnectionService = request.app.state.connections
    return service


def get_scheduler(request: Request) -> RefreshScheduler:
    """Ordonnanceur des actualisations planifiées."""
    scheduler: RefreshScheduler = request.app.state.scheduler
    return scheduler


def get_alerts(request: Request) -> AlertService:
    """Alertes sur seuil."""
    alerts: AlertService = request.app.state.alerts
    return alerts


def get_github(request: Request) -> GitHubSync:
    """Synchronisation des rapports avec GitHub."""
    github: GitHubSync = request.app.state.github
    return github


def get_atelier(request: Request) -> AtelierService:
    """Actions du nœud Atelier (docs/SUITE.md §7)."""
    service: AtelierService = request.app.state.atelier
    return service


def get_journal(request: Request) -> EventJournal:
    """Journal d'événements du nœud Atelier."""
    journal: EventJournal = request.app.state.journal
    return journal


def get_idempotency(request: Request) -> IdempotencyStore:
    """Réponses enregistrées par clé d'idempotence."""
    store: IdempotencyStore = request.app.state.idempotency
    return store


SettingsDep = Annotated[Settings, Depends(get_app_settings)]
AIServiceDep = Annotated[AIService, Depends(get_ai_service)]
DatabaseDep = Annotated[LocalDatabase, Depends(get_database)]
StoreDep = Annotated[DatasetStore, Depends(get_dataset_store)]
ReportsDep = Annotated[ReportRepository, Depends(get_report_repository)]
PreferencesDep = Annotated[PreferencesStore, Depends(get_preferences)]
ConnectionsDep = Annotated[ConnectionService, Depends(get_connections)]
SchedulerDep = Annotated[RefreshScheduler, Depends(get_scheduler)]
AlertsDep = Annotated[AlertService, Depends(get_alerts)]
GitHubDep = Annotated[GitHubSync, Depends(get_github)]
AtelierDep = Annotated[AtelierService, Depends(get_atelier)]
JournalDep = Annotated[EventJournal, Depends(get_journal)]
IdempotencyDep = Annotated[IdempotencyStore, Depends(get_idempotency)]
