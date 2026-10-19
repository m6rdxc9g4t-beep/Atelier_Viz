"""Actions déclenchées par les boutons des rapports."""

from fastapi import APIRouter

from app.api.deps import PreferencesDep
from app.services.actions import WebhookRequest, WebhookResponse, call_webhook

router = APIRouter(prefix="/actions", tags=["actions"])


@router.post("/webhook", response_model=WebhookResponse)
async def webhook(req: WebhookRequest, prefs: PreferencesDep) -> WebhookResponse:
    """Appelle un webhook (n8n, Make, Zapier…). Hors ligne : adresses locales uniquement."""
    return await call_webhook(req, online=prefs.get().online_mode)
