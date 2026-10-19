"""Actions des boutons d'automatisation : appel de webhook (n8n, Make, Zapier, API interne…).

L'appel passe par le backend (pas de problème CORS, journalisation possible).
Règle de confidentialité : en mode hors ligne, seules les adresses locales/privées sont autorisées.

Contre le « DNS rebinding » (le nom résout vers une adresse privée lors de la vérification, puis vers
une adresse publique lors de la connexion), le nom n'est résolu **qu'une fois** hors ligne : la
connexion se fait directement à l'adresse IP validée, avec l'en-tête `Host` d'origine, et TLS vérifie
le certificat pour le **nom** d'origine (extension httpx `sni_hostname`). Pas de redirection suivie.
`localhost` n'est pas résolu par un DNS externe : il est gardé tel quel (repli IPv4 / IPv6 conservé).
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


def _is_local_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    return ip.is_private or ip.is_loopback


LOOPBACK_NAMES = {"localhost", "localhost.localdomain", "ip6-localhost"}


def resolve_local(host: str) -> str | None:
    """Adresse IP locale / privée de l'hôte (une seule résolution), ou None s'il est (aussi) sur Internet.

    Toutes les adresses du nom doivent être locales : un nom qui mélange privé et public est refusé.
    `localhost` est renvoyé tel quel (résolu par la machine, jamais par un DNS du réseau).
    """
    if host.lower().rstrip(".") in LOOPBACK_NAMES:
        return host
    try:
        return host if _is_local_ip(ipaddress.ip_address(host)) else None  # littéral IP : pas de DNS
    except ValueError:
        pass
    try:
        infos = socket.getaddrinfo(host, None, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError):
        return None
    addresses = [str(info[4][0]).split("%")[0] for info in infos]
    if not addresses or not all(_is_local_ip(ipaddress.ip_address(a)) for a in addresses):
        return None
    return addresses[0]


def is_local_host(host: str) -> bool:
    """Vrai si l'hôte est la machine elle-même ou un réseau privé."""
    return resolve_local(host) is not None


def validate_target(url: str, online: bool) -> str | None:
    """Vérifie l'URL ; hors ligne, retourne l'adresse IP validée à laquelle se connecter (None en ligne)."""
    parts = urlsplit(url)
    if parts.scheme not in {"http", "https"} or not parts.hostname:
        raise ActionError("URL invalide : seules les adresses http(s) sont acceptées.")
    if online:
        return None
    pinned = resolve_local(parts.hostname)
    if pinned is None:
        raise ActionError(
            f"Mode hors ligne : « {parts.hostname} » est sur Internet. Activez le mode en ligne "
            "ou utilisez un service local (ex. n8n sur localhost).",
            403,
        )
    return pinned


def pinned_request(client: httpx.AsyncClient, req: WebhookRequest, ip: str | None) -> httpx.Request:
    """Requête du webhook ; avec `ip`, connexion à cette adresse sans nouvelle résolution du nom.

    `Host` garde le nom d'origine (hôtes virtuels) et, en HTTPS, `sni_hostname` fait vérifier le
    certificat pour ce nom (et non pour l'adresse IP).
    """
    url = httpx.URL(req.url)
    params = {k: str(v) for k, v in req.payload.items()} if req.method == "GET" else None
    body: dict[str, Any] = {"json": req.payload} if req.method == "POST" else {}
    headers: dict[str, str] = {}
    extensions: dict[str, Any] = {}
    if ip is not None and ip != url.host:
        headers["Host"] = url.netloc.decode("ascii")
        if url.scheme == "https":
            extensions["sni_hostname"] = url.raw_host.decode("ascii")
        url = url.copy_with(host=ip)
    return client.build_request(req.method, url, params=params, headers=headers, extensions=extensions, **body)


async def call_webhook(req: WebhookRequest, online: bool, client: httpx.AsyncClient | None = None) -> WebhookResponse:
    ip = await asyncio.to_thread(validate_target, req.url, online)  # résolution DNS bloquante, une seule fois
    owns_client = client is None
    client = client or httpx.AsyncClient(timeout=15.0, follow_redirects=False)
    try:
        response = await client.send(pinned_request(client, req, ip), follow_redirects=False)
    except httpx.HTTPError as exc:
        raise ActionError(f"Webhook injoignable : {exc}", 502) from exc
    finally:
        if owns_client:
            await client.aclose()
    return WebhookResponse(status_code=response.status_code, ok=response.is_success, body=response.text[:2000])
