"""E-mail des alertes : serveur SMTP de l'utilisateur. Miroir TypeScript : frontend/src/types/email.ts.

Le mot de passe va au trousseau (`email:password`) ; `data/email.json` ne contient aucun secret.
"""

import re
from typing import Literal

from pydantic import BaseModel, Field, SecretStr, field_validator

EMAIL_PATTERN = re.compile(r"^[^@\s<>,;:\"()\[\]\\]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$")
SmtpSecurity = Literal["starttls", "ssl", "none"]
MAX_RECIPIENTS = 10


def check_address(value: str) -> str:
    """Adresse e-mail simple (`nom@domaine.tld`), sans nom affiché ni retour à la ligne."""
    v = value.strip()
    if not EMAIL_PATTERN.match(v):
        raise ValueError(f"Adresse e-mail invalide : « {v[:80]} ».")
    return v


class EmailConfig(BaseModel):
    """Serveur d'envoi (sans secret)."""

    host: str = Field(min_length=1, max_length=253, pattern=r"^[A-Za-z0-9.\-:\[\]]+$")
    port: int = Field(default=587, ge=1, le=65535)
    security: SmtpSecurity = Field(
        default="starttls", description="starttls (587), ssl (465) ou none (25, réseau local)."
    )
    username: str | None = Field(default=None, max_length=200)
    from_addr: str = Field(max_length=320, description="Expéditeur (« alertes@entreprise.fr »).")

    @field_validator("host")
    @classmethod
    def _host(cls, v: str) -> str:
        host = v.strip()
        if host.startswith("[") and host.endswith("]"):
            host = host[1:-1]  # « [::1] » : adresse IPv6 sans crochets (connexion et nom du certificat)
        if not host or "[" in host or "]" in host:
            raise ValueError("Serveur d'envoi invalide.")
        return host

    @field_validator("from_addr")
    @classmethod
    def _from(cls, v: str) -> str:
        return check_address(v)

    @field_validator("username")
    @classmethod
    def _user(cls, v: str | None) -> str | None:
        if v is not None and any(c in v for c in "\r\n"):
            raise ValueError("Identifiant invalide.")
        return v or None


class EmailConfigInput(EmailConfig):
    """Enregistrement : `password` absent = inchangé, vide = effacé."""

    password: SecretStr | None = None


class EmailState(BaseModel):
    config: EmailConfig | None = None
    has_password: bool = False


class EmailTestRequest(BaseModel):
    to: list[str] = Field(min_length=1, max_length=MAX_RECIPIENTS)

    @field_validator("to")
    @classmethod
    def _to(cls, v: list[str]) -> list[str]:
        return [check_address(a) for a in v]


class EmailTestResult(BaseModel):
    ok: bool
    message: str
