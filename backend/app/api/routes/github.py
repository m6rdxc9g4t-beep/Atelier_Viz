"""Synchronisation des rapports avec un dépôt GitHub (mode en ligne uniquement, rapports seulement)."""

import asyncio

from fastapi import APIRouter

from app.api.deps import GitHubDep
from app.schemas.github import (
    GitHubConfigInput,
    GitHubState,
    GitHubTest,
    PullRequest,
    PullResult,
    PushRequest,
    PushResult,
    ReportVersion,
    ReportVersionDetail,
    RestoreRequest,
    RestoreResult,
)

router = APIRouter(prefix="/github", tags=["github"])


@router.get("", response_model=GitHubState)
async def get_state(github: GitHubDep) -> GitHubState:
    """Configuration (sans jeton) et état local des rapports depuis la dernière synchronisation (sans réseau)."""
    return await asyncio.to_thread(github.state)


@router.put("", response_model=GitHubState)
async def configure(body: GitHubConfigInput, github: GitHubDep) -> GitHubState:
    """Enregistre dépôt, branche et dossier ; le jeton va au trousseau (absent = inchangé, vide = effacé)."""
    return await asyncio.to_thread(github.configure, body)


@router.delete("", response_model=GitHubState)
async def disconnect(github: GitHubDep) -> GitHubState:
    """Oublie la configuration, l'état de synchronisation et le jeton."""
    return await asyncio.to_thread(github.disconnect)


@router.post("/test", response_model=GitHubTest)
async def test(github: GitHubDep) -> GitHubTest:
    """Vérifie le jeton et l'accès en écriture au dépôt. Hors ligne : 403."""
    return await asyncio.to_thread(github.test)


@router.post("/push", response_model=PushResult)
async def push(body: PushRequest, github: GitHubDep) -> PushResult:
    """Envoie les rapports (JSON uniquement) en un seul commit. Hors ligne : 403."""
    return await asyncio.to_thread(github.push, body)


@router.post("/pull", response_model=PullResult)
async def pull(body: PullRequest, github: GitHubDep) -> PullResult:
    """Importe les rapports du dépôt ; les conflits sont signalés, jamais écrasés sans choix. Hors ligne : 403."""
    return await asyncio.to_thread(github.pull, body)


@router.get("/reports/{report_id}/history", response_model=list[ReportVersion])
async def history(report_id: str, github: GitHubDep) -> list[ReportVersion]:
    """Commits qui ont modifié ce rapport sur la branche (30 derniers). Hors ligne : 403."""
    return await asyncio.to_thread(github.history, report_id)


@router.get("/reports/{report_id}/versions/{sha}", response_model=ReportVersionDetail)
async def version(report_id: str, sha: str, github: GitHubDep) -> ReportVersionDetail:
    """Aperçu d'une version (nom, pages, nombre de visuels). Hors ligne : 403."""
    return await asyncio.to_thread(github.version, report_id, sha)


@router.post("/reports/{report_id}/restore", response_model=RestoreResult)
async def restore(report_id: str, body: RestoreRequest, github: GitHubDep) -> RestoreResult:
    """Rétablit une version sur ce poste (ou l'importe en copie) ; rien n'est envoyé. Hors ligne : 403."""
    return await asyncio.to_thread(github.restore, report_id, body)
