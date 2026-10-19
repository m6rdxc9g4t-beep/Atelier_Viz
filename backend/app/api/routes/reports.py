"""Rapports : création, lecture, sauvegarde, suppression (fichiers JSON locaux)."""

import asyncio

from fastapi import APIRouter, HTTPException, Response, status

from app.api.deps import ReportsDep
from app.schemas.report import Report, ReportBody, ReportCreate, ReportSummary

router = APIRouter(prefix="/reports", tags=["reports"])


def _not_found(report_id: str) -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, f"Rapport « {report_id} » introuvable.")


@router.get("", response_model=list[ReportSummary])
async def list_reports(repo: ReportsDep) -> list[ReportSummary]:
    return await asyncio.to_thread(repo.list)


@router.post("", response_model=Report, status_code=status.HTTP_201_CREATED)
async def create_report(payload: ReportCreate, repo: ReportsDep) -> Report:
    """Crée un rapport vide avec une page."""
    return await asyncio.to_thread(repo.create, payload)


@router.get("/{report_id}", response_model=Report)
async def get_report(report_id: str, repo: ReportsDep) -> Report:
    report = await asyncio.to_thread(repo.get, report_id)
    if report is None:
        raise _not_found(report_id)
    return report


@router.put("/{report_id}", response_model=Report)
async def save_report(report_id: str, body: ReportBody, repo: ReportsDep) -> Report:
    """Remplace le contenu du rapport (pages, visuels, filtres)."""
    report = await asyncio.to_thread(repo.update, report_id, body)
    if report is None:
        raise _not_found(report_id)
    return report


@router.delete("/{report_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_report(report_id: str, repo: ReportsDep) -> Response:
    if not await asyncio.to_thread(repo.delete, report_id):
        raise _not_found(report_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
