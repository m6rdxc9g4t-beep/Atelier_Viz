"""Tâche du système : actualiser les sources quand l'application est fermée."""

import asyncio

from fastapi import APIRouter

from app.api.deps import BackgroundJobDep
from app.services.background_job import BackgroundJobInput, BackgroundJobState

router = APIRouter(prefix="/background", tags=["refresh"])


@router.get("", response_model=BackgroundJobState)
async def get_state(job: BackgroundJobDep) -> BackgroundJobState:
    """Prise en charge, installation, fréquence et dernier passage de la tâche."""
    return await asyncio.to_thread(job.state)


@router.put("", response_model=BackgroundJobState)
async def apply(body: BackgroundJobInput, job: BackgroundJobDep) -> BackgroundJobState:
    """Installe (ou met à jour) la tâche, ou la retire (`enabled = false`)."""
    return await asyncio.to_thread(job.apply, body)
