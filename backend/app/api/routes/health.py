"""Endpoint de santé."""

from typing import Annotated

from fastapi import APIRouter, Depends

from app import __version__
from app.api.deps import get_app_settings
from app.core.config import Settings
from app.schemas.health import HealthResponse

router = APIRouter(tags=["system"])


@router.get("/health", response_model=HealthResponse)
async def health(settings: Annotated[Settings, Depends(get_app_settings)]) -> HealthResponse:
    """Indique que l'API répond."""
    return HealthResponse(status="ok", version=__version__, environment=settings.app_env)
