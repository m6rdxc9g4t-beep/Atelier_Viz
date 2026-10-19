"""Actualisation planifiée des jeux importés depuis une connexion, journal et versions des données."""

import asyncio

from fastapi import APIRouter

from app.api.deps import SchedulerDep
from app.schemas.refresh import RefreshRun, RefreshSchedule, ScheduleState

router = APIRouter(prefix="/refresh", tags=["refresh"])


@router.get("", response_model=list[ScheduleState])
async def list_schedules(scheduler: SchedulerDep) -> list[ScheduleState]:
    """Jeux actualisables avec leur planification, la prochaine exécution et le journal."""
    return await asyncio.to_thread(scheduler.states)


@router.get("/versions", response_model=dict[str, str])
async def versions(scheduler: SchedulerDep) -> dict[str, str]:
    """Horodatage de la dernière actualisation de chaque jeu : le front recharge les visuels quand il change."""
    return await asyncio.to_thread(scheduler.versions)


@router.get("/{dataset_id}", response_model=ScheduleState)
async def get_schedule(dataset_id: str, scheduler: SchedulerDep) -> ScheduleState:
    """Planification et journal d'un jeu."""
    return await asyncio.to_thread(scheduler.get, dataset_id)


@router.put("/{dataset_id}", response_model=ScheduleState)
async def set_schedule(dataset_id: str, schedule: RefreshSchedule, scheduler: SchedulerDep) -> ScheduleState:
    """Enregistre la planification (désactivée, toutes les N minutes / heures, chaque jour à HH:MM)."""
    return await asyncio.to_thread(scheduler.set_schedule, dataset_id, schedule)


@router.post("/{dataset_id}/run", response_model=RefreshRun)
async def run_now(dataset_id: str, scheduler: SchedulerDep) -> RefreshRun:
    """Lance l'actualisation tout de suite ; le résultat (succès, erreur, sautée) est inscrit au journal."""
    await asyncio.to_thread(scheduler.get, dataset_id)  # 404 / 422 si le jeu n'est pas actualisable
    return await scheduler.run(dataset_id, "manual")
