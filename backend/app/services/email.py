"""Envoi d'e-mails (alertes) par le serveur SMTP de l'utilisateur.

Politique réseau (comme les webhooks, `services/actions.py`) :
- hors ligne, le serveur doit être la machine ou un réseau privé : le nom est résolu **une fois** et la
  connexion se fait à l'adresse validée, TLS vérifiant le certificat pour le **nom** (pas de DNS rebinding) ;
- un identifiant n'est jamais envoyé en clair (`security = "none"`) à un serveur hors du réseau privé ;
- message construit par `email.message.EmailMessage` (en-têtes encodés, retours à la ligne retirés des
  sujets) : aucune injection d'en-tête depuis le nom d'une alerte ou une valeur de dimension.
"""

import json
import os
import smtplib
import socket
import ssl
import threading
from collections.abc import Callable
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from pathlib import Path
from typing import Protocol

from app.schemas.email import EmailConfig, EmailConfigInput, EmailState, EmailTestResult, check_address
from app.services.actions import resolve_local
from app.services.connectors.secrets import SecretBackend

SECRET_KEY = "email:password"
TIMEOUT_SECONDS = 20.0


class EmailError(Exception):
    def __init__(self, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class Sender(Protocol):
    """Envoi d'un message préparé (remplaçable en test)."""

    def __call__(
        self, config: EmailConfig, pinned: str | None, password: str | None, message: EmailMessage
    ) -> None: ...


def _ssl_context() -> ssl.SSLContext:
    return ssl.create_default_context()


class _PinnedSMTP(smtplib.SMTP):
    """SMTP connecté à une IP validée ; STARTTLS vérifie le certificat pour le nom d'origine (`_host`)."""

    def __init__(self, pinned: str, **kwargs):  # type: ignore[no-untyped-def]
        self._pinned = pinned
        super().__init__(**kwargs)

    def _get_socket(self, host, port, timeout):  # type: ignore[no-untyped-def]
        return socket.create_connection((self._pinned, port), timeout, self.source_address)


class _PinnedSMTPSSL(smtplib.SMTP_SSL):
    """SMTP sur TLS implicite (465) connecté à une IP validée, certificat vérifié pour le nom."""

    def __init__(self, pinned: str, **kwargs):  # type: ignore[no-untyped-def]
        self._pinned = pinned
        super().__init__(**kwargs)

    def _get_socket(self, host, port, timeout):  # type: ignore[no-untyped-def]
        raw = socket.create_connection((self._pinned, port), timeout, self.source_address)
        return self.context.wrap_socket(raw, server_hostname=host)


def smtp_send(config: EmailConfig, pinned: str | None, password: str | None, message: EmailMessage) -> None:
    """Envoi réel (smtplib), connexion à `pinned` si fourni ; lève `EmailError` lisible."""
    ctx = _ssl_context()
    try:
        if config.security == "ssl":
            server: smtplib.SMTP = (
                _PinnedSMTPSSL(pinned, context=ctx, timeout=TIMEOUT_SECONDS)
                if pinned
                else smtplib.SMTP_SSL(context=ctx, timeout=TIMEOUT_SECONDS)
            )
        else:
            server = _PinnedSMTP(pinned, timeout=TIMEOUT_SECONDS) if pinned else smtplib.SMTP(timeout=TIMEOUT_SECONDS)
        with server:
            server.connect(config.host, config.port)
            if config.security == "starttls":
                server.starttls(context=ctx)
            if config.username and password:
                server.login(config.username, password)
            server.send_message(message)
    except smtplib.SMTPAuthenticationError as exc:
        raise EmailError("Identifiant ou mot de passe refusé par le serveur d'envoi.") from exc
    except smtplib.SMTPRecipientsRefused as exc:
        raise EmailError("Destinataire(s) refusé(s) par le serveur d'envoi.") from exc
    except UnicodeError as exc:  # smtplib encode l'identifiant et le mot de passe en ASCII
        raise EmailError(
            "Identifiant ou mot de passe refusé : le protocole d'envoi n'accepte que des caractères sans accent."
        ) from exc
    except (smtplib.SMTPException, OSError, ssl.SSLError) as exc:
        raise EmailError(f"Envoi impossible : {type(exc).__name__}.", 502) from exc
    except Exception as exc:  # noqa: BLE001 — jamais d'erreur brute (ni 500, ni alerte interrompue)
        raise EmailError(f"Envoi impossible : {type(exc).__name__}.", 502) from exc


def one_line(text: str, limit: int = 200) -> str:
    """Sujet sur une ligne : retours à la ligne et caractères de contrôle retirés."""
    clean = "".join(" " if ord(c) < 32 or c in "  " else c for c in text)
    return " ".join(clean.split())[:limit]


class EmailService:
    """Configuration SMTP (`data/email.json`, sans secret) et envoi."""

    def __init__(
        self,
        path: Path,
        secrets: SecretBackend,
        is_online: Callable[[], bool],
        sender: Sender = smtp_send,
        resolver: Callable[[str], str | None] = resolve_local,
    ) -> None:
        self.path = path
        self.secrets = secrets
        self.is_online = is_online
        self.sender = sender
        self.resolver = resolver
        self._lock = threading.Lock()

    # --- Configuration ----------------------------------------------------------------------------

    def config(self) -> EmailConfig | None:
        try:
            return EmailConfig.model_validate_json(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, ValueError):
            return None

    def state(self) -> EmailState:
        return EmailState(config=self.config(), has_password=bool(self.secrets.get(SECRET_KEY)))

    def configure(self, data: EmailConfigInput) -> EmailState:
        config = EmailConfig.model_validate(data.model_dump(exclude={"password"}))
        previous = self.config()
        with self._lock:
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(config.model_dump(), ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(tmp, self.path)
        if data.password is not None:
            if data.password.get_secret_value():
                self.secrets.set(SECRET_KEY, data.password.get_secret_value())
            else:
                self.secrets.delete(SECRET_KEY)
        elif previous and (previous.host, previous.username) != (config.host, config.username):
            # Autre serveur ou autre compte sans nouveau mot de passe : l'ancien n'est jamais réutilisé.
            self.secrets.delete(SECRET_KEY)
        return self.state()

    def forget(self) -> EmailState:
        with self._lock:
            self.path.unlink(missing_ok=True)
        self.secrets.delete(SECRET_KEY)
        return self.state()

    # --- Envoi ------------------------------------------------------------------------------------

    def _target(self, config: EmailConfig) -> str | None:
        """Adresse privée validée (connexion à cette IP, jamais une seconde résolution) ; None pour un serveur
        Internet, refusé hors ligne (403) et seulement chiffré quand un identifiant est envoyé."""
        host = config.host
        pinned = self.resolver(host)
        if pinned is None and not self.is_online():
            raise EmailError(
                f"Mode hors ligne : le serveur d'envoi « {host} » est sur Internet. Activez le mode « En ligne » "
                "ou utilisez le serveur de messagerie du réseau de l'entreprise.",
                403,
            )
        if config.security == "none" and config.username and pinned is None:
            raise EmailError("Connexion non chiffrée refusée vers un serveur Internet : choisissez STARTTLS ou SSL.")
        return pinned

    def send(self, to: list[str], subject: str, body: str) -> None:
        """Envoie un message texte ; lève `EmailError` (configuration absente, réseau, serveur)."""
        config = self.config()
        if config is None:
            raise EmailError("Configurez d'abord le serveur d'envoi (Réglages → E-mail).", 409)
        recipients = [check_address(a) for a in to][:10]
        if not recipients:
            raise EmailError("Aucun destinataire.")
        pinned = self._target(config)
        msg = EmailMessage()
        msg["From"] = config.from_addr
        msg["To"] = ", ".join(recipients)
        msg["Subject"] = one_line(subject)
        msg["Date"] = formatdate(localtime=True)
        msg["Message-ID"] = make_msgid(domain=config.from_addr.rsplit("@", 1)[-1])
        msg.set_content(body[:20_000])
        self.sender(config, pinned, self.secrets.get(SECRET_KEY), msg)

    def test(self, to: list[str]) -> EmailTestResult:
        try:
            self.send(
                to,
                "Atelier Viz · essai d'envoi",
                "Ce message confirme que les alertes d'Atelier Viz peuvent vous écrire.",
            )
        except EmailError as exc:
            if exc.status_code == 403:
                raise
            return EmailTestResult(ok=False, message=exc.message)
        return EmailTestResult(ok=True, message=f"Message d'essai envoyé à {', '.join(to)}.")
