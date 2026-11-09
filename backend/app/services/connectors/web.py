"""Fichier web : CSV, Excel ou JSON lu à une adresse http(s) (données ouvertes, export publié, serveur interne).

Politique réseau (comme les webhooks, `services/actions.py`) :
- hors ligne, l'hôte doit être la machine ou un réseau privé ; le nom est résolu **une seule fois** et la
  connexion se fait à l'adresse validée (`Host` et SNI gardent le nom) : pas de DNS rebinding ;
- les redirections sont suivies à la main (5 au plus), chaque étape revérifiée ; le jeton n'est jamais
  renvoyé vers un autre hôte que celui de l'adresse enregistrée ;
- taille bornée (`CONNECTOR_MAX_FILE_MB`), lue par morceaux ; délai borné.

Le jeton facultatif (`Authorization: Bearer …`, ou identifiant + mot de passe en Basic) reste au trousseau.
"""

import time
from collections.abc import Callable
from dataclasses import dataclass
from email.message import Message
from pathlib import PurePosixPath
from urllib.parse import unquote, urlsplit, urlunsplit

import httpx

from app.services.actions import resolve_local
from app.services.connectors.base import ConnectorError

MAX_REDIRECTS = 5

#: Type MIME → extension lue par `read_table`.
CONTENT_TYPES = {
    "text/csv": ".csv",
    "application/csv": ".csv",
    "text/tab-separated-values": ".tsv",
    "text/plain": ".csv",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
    "application/json": ".json",
    "text/json": ".json",
}
SUFFIXES = {".csv", ".tsv", ".txt", ".xlsx", ".json"}


@dataclass(frozen=True)
class WebFile:
    data: bytes
    #: Nom de fichier avec une extension reconnue (« ventes.csv »).
    name: str
    #: Adresse finale (après redirections), sans paramètres (une signature ou une clé n'est jamais renvoyée).
    url: str


def shown_url(url: str) -> str:
    """Adresse à afficher : sans paramètres ni fragment (ils peuvent porter une clé ou une signature)."""
    try:
        parts = urlsplit(url)
    except ValueError:
        return ""
    return urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


def same_origin(a: str, b: str) -> bool:
    """Même schéma, hôte et port (jeton conservé à la modification d'une connexion)."""
    try:
        x, y = httpx.URL(a.strip()), httpx.URL(b.strip())
    except (httpx.InvalidURL, ValueError):
        return False
    return (x.scheme, x.host, x.port) == (y.scheme, y.host, y.port)


def check_url(url: str) -> httpx.URL:
    """Adresse http(s) avec un nom d'hôte, sans identifiants dans l'adresse."""
    try:
        parts = urlsplit(url.strip())
    except ValueError as exc:
        raise ConnectorError("Adresse invalide.") from exc
    if parts.scheme not in {"http", "https"} or not parts.hostname:
        raise ConnectorError("Adresse attendue : https://… (http ou https, avec le nom du serveur).")
    if parts.username or parts.password:
        raise ConnectorError("Pas d'identifiant dans l'adresse : utilisez les champs Utilisateur et Jeton.")
    try:
        return httpx.URL(url.strip())
    except (httpx.InvalidURL, ValueError) as exc:
        raise ConnectorError("Adresse invalide.") from exc


def _pin(url: httpx.URL, online: bool) -> str | None:
    """Hors ligne : adresse IP privée validée à laquelle se connecter ; en ligne : None (résolution normale)."""
    if online:
        return None
    ip = resolve_local(url.host)
    if ip is None:
        raise ConnectorError(
            f"Mode hors ligne : « {url.host} » est une adresse Internet. Activez le mode « En ligne » "
            "pour lire ce fichier, ou utilisez un serveur du réseau de l'entreprise.",
            403,
        )
    return ip


def _file_name(url: httpx.URL, response: httpx.Response) -> str:
    """Nom du fichier : en-tête Content-Disposition, sinon fin de l'adresse, sinon type MIME."""
    disposition = response.headers.get("content-disposition")
    if disposition:
        msg = Message()
        msg["content-disposition"] = disposition
        name = msg.get_filename()
        if name and PurePosixPath(name).suffix.lower() in SUFFIXES:
            return PurePosixPath(name).name
    path_name = PurePosixPath(unquote(url.path)).name
    if PurePosixPath(path_name).suffix.lower() in SUFFIXES:
        return path_name
    mime = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    ext = CONTENT_TYPES.get(mime)
    if ext is None:
        raise ConnectorError(
            f"Format non reconnu ({mime or 'type inconnu'}) : l'adresse doit mener à un fichier CSV, XLSX ou JSON."
        )
    stem = PurePosixPath(path_name).stem or url.host
    return f"{stem}{ext}"


def fetch(
    url: str,
    *,
    online: bool,
    client_factory: Callable[[bool], httpx.Client],
    max_bytes: int,
    token: str | None = None,
    username: str | None = None,
    max_seconds: float = 300.0,
    clock: Callable[[], float] = time.monotonic,
) -> WebFile:
    """Télécharge le fichier (politique réseau, redirections vérifiées, taille et durée totale bornées)."""
    current = check_url(url)
    origin = (current.scheme, current.host, current.port)
    deadline = clock() + max_seconds
    # Pas de compression : la taille comptée est celle reçue (aucune « bombe » gzip qui gonfle en mémoire).
    headers: dict[str, str] = {
        "Accept": ", ".join([*CONTENT_TYPES, "*/*;q=0.5"]),
        "Accept-Encoding": "identity",
    }
    auth: httpx.Auth | None = None
    if token:
        if username:
            auth = httpx.BasicAuth(username, token)
        else:
            headers["Authorization"] = f"Bearer {token}"
    with client_factory(online) as client:
        for _ in range(MAX_REDIRECTS + 1):
            ip = _pin(current, online)
            target, extra, extensions = current, dict(headers), {}
            same_origin = (current.scheme, current.host, current.port) == origin
            if not same_origin:
                extra.pop("Authorization", None)
            if ip is not None and ip != current.host:
                extra["Host"] = current.netloc.decode("ascii")
                if current.scheme == "https":
                    extensions["sni_hostname"] = current.raw_host.decode("ascii")
                target = current.copy_with(host=ip)
            request = client.build_request("GET", target, headers=extra, extensions=extensions)
            try:
                response = client.send(request, auth=auth if same_origin else None, stream=True, follow_redirects=False)
            except httpx.InvalidURL as exc:  # httpx prépare la redirection même sans la suivre
                raise ConnectorError("Redirection invalide (http ou https attendu).", 502) from exc
            except httpx.HTTPError as exc:
                raise ConnectorError(f"Serveur injoignable : {type(exc).__name__}.", 502) from exc
            try:
                if response.is_redirect:
                    location = response.headers.get("location", "")
                    try:
                        current = check_url(str(current.join(location)))
                    except (ConnectorError, httpx.InvalidURL, ValueError) as exc:
                        raise ConnectorError("Redirection invalide (http ou https attendu).", 502) from exc
                    continue
                if response.status_code in {401, 403}:
                    raise ConnectorError(
                        f"Accès refusé (HTTP {response.status_code}) : vérifiez le jeton ou les droits."
                    )
                if response.status_code == 404:
                    raise ConnectorError("Fichier introuvable à cette adresse (HTTP 404).")
                if not response.is_success:
                    raise ConnectorError(f"Le serveur a répondu HTTP {response.status_code}.", 502)
                declared = response.headers.get("content-length")
                if declared and declared.isdigit() and int(declared) > max_bytes:
                    raise ConnectorError(f"Fichier trop volumineux (max {max_bytes // 1_000_000} Mo).", 413)
                # « identity » demandé ; un serveur qui compresse quand même est décodé bloc reçu par bloc
                # reçu, la taille décodée restant bornée par `max_bytes` (et la durée par l'échéance).
                data = bytearray()
                for chunk in response.iter_bytes():
                    data += chunk
                    if len(data) > max_bytes:
                        raise ConnectorError(f"Fichier trop volumineux (max {max_bytes // 1_000_000} Mo).", 413)
                    if clock() > deadline:
                        raise ConnectorError(f"Téléchargement trop long (plus de {int(max_seconds)} s).", 504)
                return WebFile(bytes(data), _file_name(current, response), shown_url(str(current)))
            except httpx.HTTPError as exc:
                raise ConnectorError(f"Lecture interrompue : {type(exc).__name__}.", 502) from exc
            finally:
                response.close()
    raise ConnectorError(f"Trop de redirections (plus de {MAX_REDIRECTS}).", 502)
