"""Préférences utilisateur (mode hors ligne / en ligne)."""

import asyncio

from fastapi import APIRouter

from app.api.deps import PreferencesDep
from app.services.preferences import Preferences

router = APIRouter(prefix="/settings", tags=["settings"])


@router.get("", response_model=Preferences)
async def get_preferences(prefs: PreferencesDep) -> Preferences:
    return prefs.get()


@router.put("", response_model=Preferences)
async def set_preferences(value: Preferences, prefs: PreferencesDep) -> Preferences:
    """Active ou désactive le mode en ligne (Claude, webhooks Internet). Pris en compte immédiatement."""
    return await asyncio.to_thread(prefs.set, value)
