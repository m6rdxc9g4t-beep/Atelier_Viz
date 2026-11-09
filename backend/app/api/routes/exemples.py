"""Exemples de la suite : histoires fictives reliées d'une app à l'autre (« Exemples de la suite »)."""

import asyncio
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Response, status

from app.api.deps import AlertsDep, AtelierDep, ReportsDep, SettingsDep, StoreDep
from app.services.exemples import ExempleCharge, ExempleError, ExempleHistoire, ExemplesSuite

router = APIRouter(prefix="/exemples-suite", tags=["exemples"])

HistoireId = Annotated[str, Path(max_length=64)]


def get_exemples(
    settings: SettingsDep, store: StoreDep, atelier: AtelierDep, alerts: AlertsDep, reports: ReportsDep
) -> ExemplesSuite:
    return ExemplesSuite(settings.exemples_dir, store, atelier, alerts, reports)


ExemplesDep = Annotated[ExemplesSuite, Depends(get_exemples)]


@router.get("", response_model=list[ExempleHistoire])
async def list_exemples(exemples: ExemplesDep) -> list[ExempleHistoire]:
    """Histoires livrées avec cette installation, et si leurs jeux sont déjà chargés."""
    return await asyncio.to_thread(exemples.histoires)


@router.post("/{histoire}", response_model=ExempleCharge)
async def charger_exemple(histoire: HistoireId, exemples: ExemplesDep, alerts: AlertsDep) -> ExempleCharge:
    """Crée ou met à jour les jeux de l'histoire et son alerte (créée puis évaluée, comme `POST /api/alerts`)."""
    try:
        datasets, operations_id, alert_input, rapport = await asyncio.to_thread(exemples.upsert, histoire)
    except ExempleError as exc:
        raise HTTPException(exc.status_code, exc.message) from exc
    alert_id = await asyncio.to_thread(exemples.existing_alert, alert_input.name, operations_id)
    if alert_id is None:
        created = await asyncio.to_thread(alerts.create, alert_input)
        alert_id = created.id
    alert = await alerts.evaluate(alert_id, "created")
    return ExempleCharge(
        histoire=histoire,
        datasets=datasets,
        operations_id=operations_id,
        alerte_id=alert_id,
        alerte_declenchee=bool(alert.met),
        rapport=rapport,
    )


@router.delete("/{histoire}", status_code=status.HTTP_204_NO_CONTENT)
async def retirer_exemple(histoire: HistoireId, exemples: ExemplesDep) -> Response:
    """Supprime les jeux de l'histoire, leurs alertes et le rapport d'exemple ; rien d'autre."""
    try:
        await asyncio.to_thread(exemples.retirer, histoire)
    except ExempleError as exc:
        raise HTTPException(exc.status_code, exc.message) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)
