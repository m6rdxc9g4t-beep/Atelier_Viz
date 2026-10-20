"""Préférences utilisateur (mode hors ligne / en ligne, moteur et modèles d'IA)."""

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
    """Modifie les préférences envoyées (les champs absents sont gardés). Pris en compte immédiatement.

    `online_mode` active ou désactive Claude et les webhooks Internet ; `ai_provider`, `claude_model`
    et `ollama_model` mémorisent le choix du moteur d'IA (docs/SUITE.md §5).
    """
    return await asyncio.to_thread(prefs.update, value.model_dump(exclude_unset=True))
