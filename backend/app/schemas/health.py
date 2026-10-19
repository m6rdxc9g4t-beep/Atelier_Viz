"""Schéma de l'endpoint de santé."""

from typing import Literal

from pydantic import BaseModel


class HealthResponse(BaseModel):
    """État du service."""

    status: Literal["ok"]
    version: str
    environment: str
