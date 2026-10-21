"""Alertes sur seuil : définitions, évaluation à la demande, historique, notifications dans l'application."""

import asyncio

from fastapi import APIRouter, Query, Response, status
from pydantic import BaseModel, Field

from app.api.deps import AlertsDep
from app.schemas.alert import Alert, AlertInput, AlertNotification

router = APIRouter(prefix="/alerts", tags=["alerts"])


class MarkRead(BaseModel):
    """Notifications à marquer comme lues (liste vide = toutes)."""

    ids: list[str] = Field(default_factory=list, max_length=200)


@router.get("", response_model=list[Alert])
async def list_alerts(alerts: AlertsDep, dataset_id: str | None = Query(default=None, max_length=12)) -> list[Alert]:
    """Alertes enregistrées (éventuellement d'un seul jeu), avec leur état et leur historique."""
    return await asyncio.to_thread(alerts.list_alerts, dataset_id)


@router.post("", response_model=Alert, status_code=status.HTTP_201_CREATED)
async def create_alert(body: AlertInput, alerts: AlertsDep) -> Alert:
    """Crée une alerte (mesure vérifiée sur le jeu) et l'évalue une première fois."""
    created = await asyncio.to_thread(alerts.create, body)
    return await alerts.evaluate(created.id, "created")


class SystemNotifications(BaseModel):
    """Notifications système disponibles sur cette machine (centre de notifications macOS, notify-send, Windows)."""

    available: bool


@router.get("/system", response_model=SystemNotifications)
async def system_status(alerts: AlertsDep) -> SystemNotifications:
    return SystemNotifications(available=alerts.notifier is not None)


@router.post("/system/test", response_model=SystemNotifications)
async def system_test(alerts: AlertsDep) -> SystemNotifications:
    """Envoie une notification d'essai (rien si elles ne sont pas disponibles)."""
    if alerts.notifier is not None:
        await asyncio.to_thread(alerts.notifier, "Atelier Viz", "Les notifications des alertes s'afficheront ainsi.")
    return SystemNotifications(available=alerts.notifier is not None)


@router.get("/notifications", response_model=list[AlertNotification])
async def notifications(alerts: AlertsDep) -> list[AlertNotification]:
    """Notifications dans l'application (déclenchements), la plus récente en premier."""
    return await asyncio.to_thread(alerts.notifications)


@router.post("/notifications/read", response_model=list[AlertNotification])
async def mark_read(body: MarkRead, alerts: AlertsDep) -> list[AlertNotification]:
    """Marque des notifications comme lues (toutes si la liste est vide)."""
    return await asyncio.to_thread(alerts.mark_read, body.ids)


@router.get("/{alert_id}", response_model=Alert)
async def get_alert(alert_id: str, alerts: AlertsDep) -> Alert:
    return await asyncio.to_thread(alerts.get, alert_id)


@router.put("/{alert_id}", response_model=Alert)
async def update_alert(alert_id: str, body: AlertInput, alerts: AlertsDep) -> Alert:
    """Modifie une alerte ; une nouvelle règle remet à zéro l'anti-rebond."""
    return await asyncio.to_thread(alerts.update, alert_id, body)


@router.delete("/{alert_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_alert(alert_id: str, alerts: AlertsDep) -> Response:
    await asyncio.to_thread(alerts.delete, alert_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{alert_id}/evaluate", response_model=Alert)
async def evaluate_alert(alert_id: str, alerts: AlertsDep) -> Alert:
    """Évalue l'alerte maintenant ; ses actions ne partent qu'au franchissement du seuil."""
    return await alerts.evaluate(alert_id, "manual")
