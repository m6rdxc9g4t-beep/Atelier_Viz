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
# Valeur comparée au seuil : la mesure elle-même, ou sa variation depuis l'évaluation précédente.
AlertBasis = Literal["value", "change_pct", "change_abs"]
MAX_GROUPS = 500


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
    basis: AlertBasis = Field(
        default="value",
        description="value : la mesure ; change_pct / change_abs : sa variation (%, ou écart) "
        "depuis l'évaluation précédente.",
    )
    split_by: str | None = Field(
        default=None,
        max_length=200,
        description="Dimension : l'alerte est évaluée pour chaque valeur (« pour chaque région »).",
    )
    enabled: bool = True
    notify: bool = Field(default=True, description="Notification dans l'application.")
    system: bool = Field(default=True, description="Notification système (macOS, Linux) quand l'application tourne.")
    webhook: AlertWebhook | None = None

    @model_validator(mode="after")
    def _action(self) -> "AlertInput":
        if not self.notify and not self.system and self.webhook is None:
            raise ValueError("Choisissez au moins une action : notification ou webhook.")
        return self


class AlertGroupState(BaseModel):
    """État d'anti-rebond d'une valeur de la dimension (alerte « pour chaque »)."""

    met: bool | None = None
    value: float | None = Field(default=None, description="Valeur comparée au seuil (mesure ou variation).")
    raw: float | None = Field(default=None, description="Mesure (référence de la prochaine variation).")


class AlertGroupEvent(BaseModel):
    """Résultat d'une valeur de la dimension lors d'une évaluation."""

    key: str
    value: float | None = None
    raw: float | None = None
    met: bool = False
    fired: bool = False


class AlertEvent(BaseModel):
    """Une évaluation (historique) : valeur mesurée, condition remplie, déclenchement, actions."""

    id: str | None = Field(default=None, description="Identifiant (complété par le résultat du webhook).")
    at: datetime
    trigger: AlertTrigger
    value: float | None = Field(default=None, description="Valeur comparée (sans dimension).")
    raw: float | None = Field(default=None, description="Mesure, quand la valeur comparée est une variation.")
    met: bool = False
    fired: bool = Field(default=False, description="Franchissement du seuil : actions lancées.")
    groups: list[AlertGroupEvent] = Field(
        default_factory=list, description="Alerte « pour chaque » : valeurs qui remplissent la condition (50 au plus)."
    )
    groups_count: int | None = Field(default=None, description="Nombre de valeurs évaluées (alerte « pour chaque »).")
    error: str | None = None
    note: str | None = Field(default=None, description="Information (première mesure d'une variation…).")
    webhook_status: int | None = None
    webhook_error: str | None = None


class Alert(AlertInput):
    """Alerte enregistrée (`data/alerts.json`) avec son état d'anti-rebond et son historique."""

    id: str
    created_at: datetime
    met: bool | None = Field(default=None, description="Condition remplie à la dernière évaluation (anti-rebond).")
    last_value: float | None = None
    last_raw: float | None = Field(default=None, description="Dernière mesure (référence d'une alerte sur variation).")
    groups: dict[str, AlertGroupState] = Field(default_factory=dict, description="État par valeur de la dimension.")
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
    group: str | None = Field(default=None, description="Valeur de la dimension (alerte « pour chaque »).")
    threshold: float
    comparison: Comparison
    at: datetime
    read: bool = False
