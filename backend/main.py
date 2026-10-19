"""Point d'entrée de l'API Atelier Viz.

Lancer depuis le dossier backend/ :  uvicorn main:app --reload
Documentation interactive :          http://localhost:8000/docs
"""

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app import __version__
from app.api.deps import build_ai_service
from app.api.router import api_router
from app.core.config import Settings, get_settings
from app.services.actions import ActionError
from app.services.ai import AIProviderError
from app.services.alerts import AlertError, AlertService
from app.services.connectors import ConnectionService, ConnectorError, build_secrets
from app.services.data import DatasetStore
from app.services.engine import LocalDatabase, QueryError
from app.services.github import GitHubError, GitHubSync
from app.services.preferences import PreferencesStore
from app.services.refresh import RefreshScheduler
from app.services.reports import ReportRepository


def create_app(settings: Settings | None = None) -> FastAPI:
    """Fabrique de l'application (permet d'injecter une configuration en test)."""
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        data_dir = settings.data_dir
        app.state.preferences = PreferencesStore(data_dir / "settings.json")
        app.state.database = LocalDatabase(data_dir / "atelier.duckdb")
        app.state.dataset_store = DatasetStore(app.state.database)
        app.state.reports = ReportRepository(data_dir / "reports")
        secrets = build_secrets(settings.secrets_backend, data_dir / "secrets.json")
        app.state.connections = ConnectionService(
            data_dir / "connections.json",
            secrets,
            settings,
            app.state.dataset_store,
            is_online=lambda: app.state.preferences.get().online_mode,
        )
        app.state.ai_service = build_ai_service(settings, is_online=lambda: app.state.preferences.get().online_mode)
        # Actualisation planifiée des jeux importés (fichier à côté de connections.json).
        app.state.scheduler = RefreshScheduler(
            data_dir / "schedules.json",
            app.state.dataset_store,
            app.state.connections.refresh,
            is_online=lambda: app.state.preferences.get().online_mode,
        )
        # Synchronisation des rapports avec GitHub (en ligne uniquement ; jeton au trousseau).
        app.state.github = GitHubSync(
            data_dir / "github.json",
            app.state.reports,
            secrets,
            is_online=lambda: app.state.preferences.get().online_mode,
            env_token=lambda: settings.github_token.get_secret_value() if settings.github_token else None,
        )
        # Alertes sur seuil : évaluées après chaque actualisation réussie d'un jeu.
        app.state.alerts = AlertService(
            data_dir / "alerts.json",
            app.state.dataset_store,
            app.state.database,
            is_online=lambda: app.state.preferences.get().online_mode,
        )
        app.state.scheduler.on_refreshed(app.state.alerts.evaluate_dataset)
        ticker = (
            asyncio.create_task(app.state.scheduler.run_forever(settings.scheduler_period_seconds))
            if settings.scheduler_enabled
            else None
        )
        yield
        if ticker is not None:
            ticker.cancel()
            with suppress(asyncio.CancelledError):
                await ticker
        await app.state.ai_service.aclose()
        app.state.database.close()

    app = FastAPI(title=settings.app_name, version=__version__, lifespan=lifespan)
    app.state.settings = settings

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(AIProviderError)
    async def ai_provider_error_handler(_: Request, exc: AIProviderError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.message, "provider": exc.provider})

    @app.exception_handler(QueryError)
    async def query_error_handler(_: Request, exc: QueryError) -> JSONResponse:
        return JSONResponse(status_code=422, content={"detail": str(exc)})

    @app.exception_handler(ActionError)
    async def action_error_handler(_: Request, exc: ActionError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"detail": str(exc)})

    @app.exception_handler(AlertError)
    async def alert_error_handler(_: Request, exc: AlertError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.message})

    @app.exception_handler(GitHubError)
    async def github_error_handler(_: Request, exc: GitHubError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.message})

    @app.exception_handler(ConnectorError)
    async def connector_error_handler(_: Request, exc: ConnectorError) -> JSONResponse:
        return JSONResponse(status_code=exc.status_code, content={"detail": exc.message})

    app.include_router(api_router)

    # Interface compilée (frontend/dist) : l'application complète sur une seule adresse, sans Vite.
    # Montée après l'API : les routes /api/... restent prioritaires.
    dist = settings.frontend_dist
    if settings.serve_frontend and (dist / "index.html").is_file():
        app.mount("/", StaticFiles(directory=dist, html=True), name="frontend")
    return app


app = create_app()
