"""E-mail des alertes : serveur SMTP de l'utilisateur (mot de passe au trousseau)."""

import asyncio

from fastapi import APIRouter

from app.api.deps import EmailDep
from app.schemas.email import EmailConfigInput, EmailState, EmailTestRequest, EmailTestResult

router = APIRouter(prefix="/email", tags=["email"])


@router.get("", response_model=EmailState)
async def get_state(email: EmailDep) -> EmailState:
    """Serveur d'envoi enregistré (sans mot de passe)."""
    return await asyncio.to_thread(email.state)


@router.put("", response_model=EmailState)
async def configure(body: EmailConfigInput, email: EmailDep) -> EmailState:
    """Enregistre le serveur ; le mot de passe va au trousseau (absent = inchangé, vide = effacé)."""
    return await asyncio.to_thread(email.configure, body)


@router.delete("", response_model=EmailState)
async def forget(email: EmailDep) -> EmailState:
    """Oublie le serveur et son mot de passe."""
    return await asyncio.to_thread(email.forget)


@router.post("/test", response_model=EmailTestResult)
async def test(body: EmailTestRequest, email: EmailDep) -> EmailTestResult:
    """Envoie un message d'essai. Hors ligne, serveur sur Internet : 403."""
    return await asyncio.to_thread(email.test, body.to)
