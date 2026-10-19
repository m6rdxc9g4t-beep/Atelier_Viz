"""Actualisation planifiée des jeux importés depuis une connexion. Miroir TypeScript : frontend/src/types/refresh.ts."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.schemas.connection import ConnectorKind

ScheduleMode = Literal["off", "interval", "daily"]
RunStatus = Literal["success", "error", "skipped"]
RunTrigger = Literal["schedule", "manual"]


class RefreshSchedule(BaseModel):
    """Planification d'un jeu : désactivée, toutes les N minutes / heures, ou chaque jour à HH:MM (heure locale)."""

    mode: ScheduleMode = "off"
    every: int = Field(default=1, ge=1, le=10_000, description="Intervalle (mode `interval`).")
    unit: Literal["minutes", "hours"] = "hours"
    at: str = Field(
        default="07:00", pattern=r"^([01]\d|2[0-3]):[0-5]\d$", description="Heure locale (mode `daily`), HH:MM."
    )

    @model_validator(mode="after")
    def _bounds(self) -> "RefreshSchedule":
        if self.mode == "interval" and self.minutes > 7 * 24 * 60:
            raise ValueError("Intervalle trop long : une semaine au plus (utilisez « chaque jour »).")
        return self

    @property
    def minutes(self) -> int:
        """Intervalle en minutes (mode `interval`)."""
        return self.every * (60 if self.unit == "hours" else 1)


class RefreshRun(BaseModel):
    """Une exécution d'actualisation (journal)."""

    started_at: datetime
    duration_ms: int = Field(ge=0)
    status: RunStatus
    trigger: RunTrigger
    rows: int | None = Field(default=None, description="Lignes après actualisation (succès).")
    message: str | None = None


class ScheduleState(BaseModel):
    """Planification d'un jeu, avec la prochaine exécution et le journal (le plus récent d'abord)."""

    dataset_id: str
    dataset_name: str
    connection_name: str
    kind: ConnectorKind
    schedule: RefreshSchedule
    next_run: datetime | None = None
    running: bool = False
    needs_online: bool = Field(
        default=False, description="Source sur Internet (SharePoint) : mode « En ligne » requis."
    )
    refreshed_at: datetime | None = Field(default=None, description="Dernière actualisation réussie.")
    runs: list[RefreshRun] = Field(default_factory=list)
