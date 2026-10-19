"""Point d'entrée de l'API Atelier Viz.

Lancer depuis le dossier backend/ :  uvicorn main:app --reload
Documentation interactive :          http://localhost:8000/docs
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app import __version__
from app.api.deps import build_ai_service
from app.api.router import api_router
from app.core.config import Settings, get_settings
from app.services.actions import ActionError
from app.services.ai import AIProviderError
from app.services.data import DatasetStore
from app.services.engine import LocalDatabase, QueryError
from app.services.preferences import PreferencesStore
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
        app.state.ai_service = build_ai_service(settings, is_online=lambda: app.state.preferences.get().online_mode)
        yield
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

    app.include_router(api_router)
    return app


app = create_app()
