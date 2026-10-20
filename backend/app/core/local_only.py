"""Garde « requêtes locales » de l'API (docs/SUITE.md §5.1), sur le modèle d'Atelier Projets.

Protège l'API locale contre les sites web visités dans le navigateur :
- « DNS rebinding » : un domaine externe qui pointe soudain vers 127.0.0.1 envoie un en-tête `Host` étranger ;
  il pourrait sinon lire l'API, passer Viz en ligne et appeler Claude sur l'abonnement de l'utilisateur ;
- requêtes d'un autre site (CSRF) : l'en-tête `Origin` d'une écriture désigne alors un hôte étranger.

Règles : `Host` de bouclage obligatoire (`127.0.0.1`, `localhost`, `[::1]`, port quelconque) ou listé dans
`ALLOWED_HOSTS` ; pour les écritures (POST, PUT, PATCH, DELETE), `Origin` absente ou de bouclage / listée.
L'origine `null` (iframe isolée, URL data:, fichier local) est refusée en écriture. Les outils sans navigateur
(curl, scripts, app de bureau qui sonde `/api/health`) n'envoient pas d'`Origin` et restent acceptés.
"""

import json
from collections.abc import Iterable
from urllib.parse import urlsplit

from starlette.types import ASGIApp, Receive, Scope, Send

LOCAL_HOSTS = frozenset({"127.0.0.1", "localhost", "::1"})
UNSAFE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


def host_name(value: str) -> str:
    """Nom d'hôte d'un en-tête Host (« 127.0.0.1:8000 », « [::1]:8000 »), en minuscules et sans port."""
    host = value.strip().lower()
    if host.startswith("["):
        end = host.find("]")
        return host[1:end] if end != -1 else host[1:]
    # Une seule « : » = séparateur de port ; plusieurs = adresse IPv6 sans crochets (gardée telle quelle).
    return host.rsplit(":", 1)[0] if host.count(":") == 1 else host


def allowed_hosts(extra: Iterable[str] = ()) -> frozenset[str]:
    """Hôtes acceptés : ceux de bouclage, plus la liste fournie (`ALLOWED_HOSTS`)."""
    return LOCAL_HOSTS | {host_name(h) for h in extra if h.strip()}


def origin_host(origin: str) -> str | None:
    """Nom d'hôte d'un en-tête Origin (« http://127.0.0.1:5173 »), ou None s'il est illisible ou `null`."""
    try:
        parts = urlsplit(origin.strip())
    except ValueError:
        return None
    if parts.scheme not in {"http", "https"} or not parts.hostname:
        return None
    return parts.hostname.lower()


def refusal(method: str, host: str | None, origin: str | None, hosts: frozenset[str]) -> str | None:
    """Message de refus (en français) d'une requête, ou None si elle est acceptée."""
    if host is None or host_name(host) not in hosts:
        return f"Hôte « {host or ''} » refusé : l'API n'accepte que les requêtes locales (voir ALLOWED_HOSTS)."
    if origin is not None and method.upper() in UNSAFE_METHODS:
        name = origin_host(origin)
        if name is None or name not in hosts:
            return f"Origine « {origin} » refusée : seule l'interface locale peut modifier les données."
    return None


class LocalOnlyMiddleware:
    """Middleware ASGI : refuse (403, JSON `{"detail": …}`) toute requête qui n'est pas locale."""

    def __init__(self, app: ASGIApp, hosts: Iterable[str] = ()) -> None:
        self.app = app
        self.hosts = allowed_hosts(hosts)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] not in {"http", "websocket"}:
            await self.app(scope, receive, send)
            return
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        method = scope.get("method", "GET") if scope["type"] == "http" else "POST"  # websocket : comme une écriture
        message = refusal(method, headers.get("host"), headers.get("origin"), self.hosts)
        if message is None:
            await self.app(scope, receive, send)
            return
        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 1008})
            return
        body = json.dumps({"detail": message}, ensure_ascii=False).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": 403,
                "headers": [
                    (b"content-type", b"application/json; charset=utf-8"),
                    (b"content-length", str(len(body)).encode()),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})
