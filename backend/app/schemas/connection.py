"""Connexions aux sources de données externes (SQL Server, PostgreSQL, MySQL, SQLite, fichiers, SharePoint,
Atelier Tab, Atelier Projets).

Miroir TypeScript : frontend/src/types/connection.ts.
Les mots de passe et jetons ne sont jamais renvoyés par l'API (`has_password`, `signed_in`).
"""

from datetime import datetime
from typing import Any, Literal
from urllib.parse import urlparse

from pydantic import BaseModel, Field, SecretStr, model_validator

from app.core.network import is_loopback_host, loopback_refusal

ConnectorKind = Literal[
    "sqlserver", "postgres", "mysql", "sqlite", "file", "sharepoint", "atelier_tab", "atelier_projets"
]
SQL_KINDS: tuple[ConnectorKind, ...] = ("sqlserver", "postgres", "mysql", "sqlite")
SERVER_KINDS: tuple[ConnectorKind, ...] = ("sqlserver", "postgres", "mysql")
# Applications de la Suite Atelier (docs/SUITE.md §4.2 et §4.3) : aucun secret.
SUITE_KINDS: tuple[ConnectorKind, ...] = ("atelier_tab", "atelier_projets")


class ConnectionFields(BaseModel):
    """Paramètres communs d'une connexion (sans secret)."""

    name: str = Field(min_length=1, max_length=80)
    kind: ConnectorKind
    # Serveurs SQL
    host: str | None = Field(
        default=None, max_length=255, description="Serveur (nom ou adresse), ex. sql01\\PROD ou 10.0.0.5."
    )
    port: int | None = Field(default=None, ge=1, le=65535)
    database: str | None = Field(default=None, max_length=255)
    username: str | None = Field(default=None, max_length=255)
    encrypt: bool = Field(default=False, description="SQL Server : chiffrement TLS exigé.")
    # SQLite et fichiers (OneDrive / SharePoint synchronisés) ; Atelier Tab : dossier des instantanés (vide = défaut)
    path: str | None = Field(
        default=None, max_length=1000, description="Chemin du fichier (ou dossier) sur cette machine."
    )
    # Atelier Projets : adresse de l'API locale (vide = ATELIER_PROJETS_URL, http://127.0.0.1:3000)
    base_url: str | None = Field(default=None, max_length=500, description="Adresse d'Atelier Projets.")
    # SharePoint Online (Microsoft Graph)
    tenant: str | None = Field(
        default=None, max_length=200, description="Locataire Microsoft 365 (domaine ou identifiant)."
    )
    client_id: str | None = Field(
        default=None, max_length=100, description="Application Entra ID (sinon SHAREPOINT_CLIENT_ID)."
    )

    @model_validator(mode="after")
    def _required(self) -> "ConnectionFields":
        if self.kind in SERVER_KINDS and not (self.host and self.host.strip()):
            raise ValueError("Le serveur est obligatoire.")
        if self.kind in {"sqlite", "file"} and not (self.path and self.path.strip()):
            raise ValueError("Le chemin du fichier est obligatoire.")
        if self.kind == "atelier_projets" and self.base_url and self.base_url.strip():
            parsed = urlparse(self.base_url.strip())
            if parsed.scheme not in {"http", "https"} or not parsed.hostname:
                raise ValueError("Adresse attendue : http://127.0.0.1:3000 (http ou https, avec le nom du serveur).")
        return self


class ConnectionInput(ConnectionFields):
    """Création ou modification. `password` absent à la modification = mot de passe inchangé."""

    password: SecretStr | None = Field(default=None, description="Jamais renvoyé ; stocké dans le trousseau système.")

    @model_validator(mode="after")
    def _local_projets(self) -> "ConnectionInput":
        # docs/SUITE.md §4.3 : Atelier Projets est local, quel que soit le mode. Contrôle de forme ici
        # (les connexions déjà enregistrées restent lisibles) ; la résolution est vérifiée à chaque appel.
        if self.kind == "atelier_projets" and self.base_url and self.base_url.strip():
            host = urlparse(self.base_url.strip()).hostname or ""
            if not is_loopback_host(host):
                raise ValueError(loopback_refusal(host, "Atelier Projets"))
        return self


class Connection(ConnectionFields):
    """Connexion enregistrée (`data/connections.json`), sans aucun secret."""

    id: str
    created_at: datetime
    has_password: bool = False
    signed_in: bool = Field(default=False, description="SharePoint : jeton Microsoft disponible.")
    account: str | None = Field(default=None, description="SharePoint : compte connecté.")


class TableRef(BaseModel):
    """Table ou vue d'une base, feuille d'un classeur Excel (`schema` vide), table publiée par Atelier Tab
    (`snapshot`, `schema` = projet) ou jeu de données d'Atelier Projets (`dataset`)."""

    schema_: str | None = Field(default=None, alias="schema", max_length=255)
    name: str = Field(min_length=1, max_length=255)
    kind: Literal["table", "view", "sheet", "list", "snapshot", "dataset"] = "table"
    id: str | None = Field(
        default=None,
        max_length=255,
        description="Identifiant stable dans la source (fichier d'Atelier Tab, nom du jeu d'Atelier Projets).",
    )
    description: str | None = Field(default=None, max_length=500)
    updated_at: datetime | None = Field(default=None, description="Date de publication (Atelier Tab).")
    rows: int | None = Field(default=None, ge=0, description="Nombre de lignes annoncé par la source.")

    model_config = {"populate_by_name": True}


class SourceSpec(BaseModel):
    """Ce qu'on lit dans la source : une table, une requête SELECT, une feuille, ou un élément SharePoint."""

    table: TableRef | None = None
    query: str | None = Field(
        default=None, max_length=20000, description="Une seule requête SELECT / WITH, en lecture seule."
    )
    url: str | None = Field(default=None, max_length=2000, description="SharePoint : lien d'un fichier ou d'une liste.")
    project_id: str | None = Field(
        default=None, max_length=100, description="Atelier Projets : limiter le jeu à un projet (sinon tous)."
    )

    @model_validator(mode="after")
    def _one(self) -> "SourceSpec":
        given = [x for x in (self.table, self.query and self.query.strip(), self.url and self.url.strip()) if x]
        if len(given) > 1:
            raise ValueError("Indiquez une table, une requête ou un lien, pas plusieurs.")
        return self


class PreviewRequest(SourceSpec):
    limit: int = Field(default=50, ge=1, le=200)


class ImportRequest(SourceSpec):
    name: str | None = Field(
        default=None, max_length=200, description="Nom du jeu de données (sinon déduit de la source)."
    )
    max_rows: int | None = Field(default=None, ge=1, le=10_000_000)


class PreviewResult(BaseModel):
    columns: list[str]
    rows: list[dict[str, Any]]
    truncated: bool = Field(description="Plus de lignes que l'aperçu n'en montre.")


class TestResult(BaseModel):
    ok: bool
    message: str
    server: str | None = Field(default=None, description="Version du serveur, si connue.")


class ProjectRef(BaseModel):
    """Projet d'Atelier Projets (filtre facultatif d'un jeu de données)."""

    id: str
    name: str


class TableList(BaseModel):
    tables: list[TableRef]
    truncated: bool = False
    projects: list[ProjectRef] = Field(default_factory=list, description="Atelier Projets : projets disponibles.")
    location: str | None = Field(default=None, description="Dossier ou adresse effectivement lus.")


class ConnectorInfo(BaseModel):
    """Type de source proposé à l'utilisateur, avec l'état de son pilote."""

    kind: ConnectorKind
    label: str
    description: str
    driver_installed: bool
    install_hint: str | None = None
    default_port: int | None = None
    needs_online: bool = Field(default=False, description="Toujours sur Internet (SharePoint Online).")
    configured: bool = Field(default=True, description="SharePoint : application Entra ID renseignée.")
    default_location: str | None = Field(
        default=None, description="Atelier Tab : dossier par défaut ; Atelier Projets : adresse par défaut."
    )


class DeviceCodeStart(BaseModel):
    """Connexion Microsoft par code (à saisir sur microsoft.com/devicelogin)."""

    user_code: str
    verification_uri: str
    message: str
    expires_in: int
    interval: int


class AuthStatus(BaseModel):
    status: Literal["pending", "signed_in", "expired", "denied", "error"]
    account: str | None = None
    message: str | None = None


class DatasetOrigin(BaseModel):
    """Provenance d'un jeu importé depuis une connexion : permet de l'actualiser."""

    connection_id: str
    connection_name: str
    kind: ConnectorKind
    table: TableRef | None = None
    query: str | None = None
    url: str | None = None
    project_id: str | None = None
    max_rows: int | None = None
    truncated: bool = Field(default=False, description="Limite de lignes atteinte au dernier chargement.")
    refreshed_at: datetime
