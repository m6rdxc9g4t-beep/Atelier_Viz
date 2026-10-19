"""Actions des boutons d'automatisation : appel de webhook (n8n, Make, Zapier, API interne…).

L'appel passe par le backend (pas de problème CORS, journalisation possible).
Règle de confidentialité : en mode hors ligne, seules les adresses locales/privées sont autorisées.
"""

import asyncio
import ipaddress
import socket
from typing import Any, Literal
from urllib.parse import urlsplit

import httpx
from pydantic import BaseModel, Field


class WebhookRequest(BaseModel):
    url: str = Field(max_length=2000)
    method: Literal["GET", "POST"] = "POST"
    payload: dict[str, Any] = Field(default_factory=dict)


class WebhookResponse(BaseModel):
    status_code: int
    ok: bool
    body: str = Field(description="Début de la réponse (2000 caractères max).")


class ActionError(ValueError):
    def __init__(self, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.status_code = status_code


def is_local_host(host: str) -> bool:
    """Vrai si l'hôte est la machine elle-même ou un réseau privé."""
    if host in {"localhost", "host.docker.internal"} or host.endswith(".local"):
        return True
    try:
        addresses = {info[4][0] for info in socket.getaddrinfo(host, None)}
    except socket.gaierror:
        return False
    ips = [ipaddress.ip_address(a.split("%")[0]) for a in addresses]
    return all(ip.is_private or ip.is_loopback for ip in ips)


def validate_target(url: str, online: bool) -> None:
    parts = urlsplit(url)
    if parts.scheme not in {"http", "https"} or not parts.hostname:
        raise ActionError("URL invalide : seules les adresses http(s) sont acceptées.")
    if not online and not is_local_host(parts.hostname):
        raise ActionError(
            f"Mode hors ligne : « {parts.hostname} » est sur Internet. Activez le mode en ligne "
            "ou utilisez un service local (ex. n8n sur localhost).",
            403,
        )


async def call_webhook(req: WebhookRequest, online: bool, client: httpx.AsyncClient | None = None) -> WebhookResponse:
    await asyncio.to_thread(validate_target, req.url, online)  # résolution DNS bloquante
    owns_client = client is None
    client = client or httpx.AsyncClient(timeout=15.0, follow_redirects=False)
    try:
        if req.method == "GET":
            response = await client.get(req.url, params={k: str(v) for k, v in req.payload.items()})
        else:
            response = await client.post(req.url, json=req.payload)
    except httpx.HTTPError as exc:
        raise ActionError(f"Webhook injoignable : {exc}", 502) from exc
    finally:
        if owns_client:
            await client.aclose()
    return WebhookResponse(status_code=response.status_code, ok=response.is_success, body=response.text[:2000])
