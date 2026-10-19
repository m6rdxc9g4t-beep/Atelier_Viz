"""Agrégation de toutes les routes sous le préfixe /api."""

from fastapi import APIRouter

from app.api.routes import (
    actions,
    ai,
    alerts,
    connections,
    datasets,
    health,
    query,
    refresh,
    reports,
    samples,
    settings,
)

api_router = APIRouter(prefix="/api")
api_router.include_router(health.router)
api_router.include_router(settings.router)
api_router.include_router(ai.router)
api_router.include_router(datasets.router)
api_router.include_router(query.router)
api_router.include_router(reports.router)
api_router.include_router(actions.router)
api_router.include_router(samples.router)
api_router.include_router(connections.router)
api_router.include_router(refresh.router)
api_router.include_router(alerts.router)
