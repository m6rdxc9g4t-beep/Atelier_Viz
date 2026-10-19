"""Alertes sur seuil. Miroir TypeScript : frontend/src/types/alert.ts.

La mesure est une `Measure` du langage de requête (agrégat sur un champ, ou mesure calculée du
modèle avec `agg = "calc"`) : elle est compilée par le moteur existant, jamais en SQL brut.
"""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.schemas.query import Filter, Measure

Comparison = Literal["gt", "gte", "lt", "lte", "eq", "neq"]
COMPARISON_SYMBOL: dict[Comparison, str] = {"gt": ">", "gte": "≥", "lt": "<", "lte": "≤", "eq": "=", "neq": "≠"}
AlertTrigger = Literal["refresh", "manual", "created"]


class AlertWebhook(BaseModel):
    """Webhook appelé au déclenchement (via `app/services/actions.py` : externe seulement en ligne)."""

    url: str = Field(min_length=1, max_length=2000)
    method: Literal["GET", "POST"] = "POST"


class AlertInput(BaseModel):
    """Création ou modification d'une alerte."""

    name: str = Field(min_length=1, max_length=120)
    dataset_id: str = Field(pattern=r"^[0-9a-f]{12}$")
    measure: Measure
    filters: list[Filter] = Field(default_factory=list, max_length=20)
    comparison: Comparison = "gt"
    threshold: float
    enabled: bool = True
    notify: bool = Field(default=True, description="Notification dans l'application.")
    webhook: AlertWebhook | None = None

    @model_validator(mode="after")
    def _action(self) -> "AlertInput":
        if not self.notify and self.webhook is None:
            raise ValueError("Choisissez au moins une action : notification ou webhook.")
        return self


class AlertEvent(BaseModel):
    """Une évaluation (historique) : valeur mesurée, condition remplie, déclenchement, actions."""

    id: str | None = Field(default=None, description="Identifiant (complété par le résultat du webhook).")
    at: datetime
    trigger: AlertTrigger
    value: float | None = None
    met: bool = False
    fired: bool = Field(default=False, description="Franchissement du seuil : actions lancées.")
    error: str | None = None
    webhook_status: int | None = None
    webhook_error: str | None = None


class Alert(AlertInput):
    """Alerte enregistrée (`data/alerts.json`) avec son état d'anti-rebond et son historique."""

    id: str
    created_at: datetime
    met: bool | None = Field(default=None, description="Condition remplie à la dernière évaluation (anti-rebond).")
    last_value: float | None = None
    last_evaluated_at: datetime | None = None
    last_fired_at: datetime | None = None
    history: list[AlertEvent] = Field(default_factory=list, description="Le plus récent en premier.")


class AlertNotification(BaseModel):
    """Notification dans l'application (déclenchement d'une alerte)."""

    id: str
    alert_id: str
    alert_name: str
    dataset_id: str
    message: str
    value: float
    threshold: float
    comparison: Comparison
    at: datetime
    read: bool = False
