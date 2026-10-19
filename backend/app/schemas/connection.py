"""Connexions aux sources de données externes (SQL Server, PostgreSQL, MySQL, SQLite, fichiers, SharePoint).

Miroir TypeScript : frontend/src/types/connection.ts.
Les mots de passe et jetons ne sont jamais renvoyés par l'API (`has_password`, `signed_in`).
"""

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, SecretStr, model_validator

ConnectorKind = Literal["sqlserver", "postgres", "mysql", "sqlite", "file", "sharepoint"]
SQL_KINDS: tuple[ConnectorKind, ...] = ("sqlserver", "postgres", "mysql", "sqlite")
SERVER_KINDS: tuple[ConnectorKind, ...] = ("sqlserver", "postgres", "mysql")


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
    # SQLite et fichiers (OneDrive / SharePoint synchronisés)
    path: str | None = Field(default=None, max_length=1000, description="Chemin du fichier sur cette machine.")
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
        return self


class ConnectionInput(ConnectionFields):
    """Création ou modification. `password` absent à la modification = mot de passe inchangé."""

    password: SecretStr | None = Field(default=None, description="Jamais renvoyé ; stocké dans le trousseau système.")


class Connection(ConnectionFields):
    """Connexion enregistrée (`data/connections.json`), sans aucun secret."""

    id: str
    created_at: datetime
    has_password: bool = False
    signed_in: bool = Field(default=False, description="SharePoint : jeton Microsoft disponible.")
    account: str | None = Field(default=None, description="SharePoint : compte connecté.")


class TableRef(BaseModel):
    """Table ou vue d'une base, ou feuille d'un classeur Excel (`schema` vide)."""

    schema_: str | None = Field(default=None, alias="schema", max_length=255)
    name: str = Field(min_length=1, max_length=255)
    kind: Literal["table", "view", "sheet", "list"] = "table"

    model_config = {"populate_by_name": True}


class SourceSpec(BaseModel):
    """Ce qu'on lit dans la source : une table, une requête SELECT, une feuille, ou un élément SharePoint."""

    table: TableRef | None = None
    query: str | None = Field(
        default=None, max_length=20000, description="Une seule requête SELECT / WITH, en lecture seule."
    )
    url: str | None = Field(default=None, max_length=2000, description="SharePoint : lien d'un fichier ou d'une liste.")

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


class TableList(BaseModel):
    tables: list[TableRef]
    truncated: bool = False


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
    max_rows: int | None = None
    truncated: bool = Field(default=False, description="Limite de lignes atteinte au dernier chargement.")
    refreshed_at: datetime
