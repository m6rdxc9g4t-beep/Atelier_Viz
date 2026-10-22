"""Nœud Atelier (docs/SUITE.md §7, contrat `atelier-node/1`) : manifeste, table d'échange, événements.

Miroir TypeScript : frontend/src/types/atelier.ts.
Ces schémas décrivent ce qu'Atelier Nexus peut enchaîner dans un workflow ; les `input_schema` et
`data_schema` du manifeste sont générés à partir d'eux (JSON Schema draft 2020-12, propriétés en snake_case).
"""

from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from app.schemas.alert import AlertBasis, Comparison
from app.schemas.connection import ATELIER_KEY_PATTERN

CONTRACT = "atelier-node/1"
TABLE_FORMAT = "atelier-table/1"
ACTION_ID_PATTERN = r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$"
EVENT_TYPE_PATTERN = r"^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$"
DATASET_ID_PATTERN = r"^[0-9a-f]{12}$"

# Bornes des routes /api/atelier/* (docs/SUITE.md §7).
TABLE_DEFAULT_LIMIT = 1000
TABLE_MAX_LIMIT = 5000
UPSERT_MAX_ROWS = 100_000
UPSERT_MAX_COLUMNS = 200
EVENTS_DEFAULT_LIMIT = 100
EVENTS_MAX_LIMIT = 500

AtelierType = Literal["string", "number", "date", "datetime", "boolean"]


# --- Table d'échange `atelier-table/1` (§7.2) -------------------------------------------------------


class AtelierColumn(BaseModel):
    """Colonne d'une table d'échange : clé `snake_case` sans accent, libellé en français."""

    key: str = Field(min_length=1, max_length=200, description="Clé snake_case, unique dans la table.")
    label: str = Field(min_length=1, max_length=200, description="Libellé affiché (français, avec accents).")
    type: AtelierType


class AtelierTable(BaseModel):
    """Table qui passe d'une étape de workflow à l'autre (`rows` utilise les `key` des colonnes)."""

    format: Literal["atelier-table/1"] = TABLE_FORMAT
    name: str = Field(min_length=1, max_length=200, description="Identifiant de la table (« work-items »).")
    label: str | None = Field(default=None, max_length=200, description="Nom affiché de la table.")
    columns: list[AtelierColumn] = Field(min_length=1, max_length=UPSERT_MAX_COLUMNS)
    rows: list[dict[str, Any]] = Field(default_factory=list, max_length=UPSERT_MAX_ROWS)
    total: int | None = Field(default=None, ge=0, description="Nombre complet de lignes, si connu.")
    truncated: bool = Field(default=False, description="Vrai quand `rows` ne contient pas toutes les lignes.")

    @field_validator("columns")
    @classmethod
    def _unique_keys(cls, columns: list[AtelierColumn]) -> list[AtelierColumn]:
        seen: set[str] = set()
        for col in columns:
            if col.key in seen:
                raise ValueError(f"Clé de colonne en double : « {col.key} ».")
            seen.add(col.key)
        return columns


# --- Entrées et sorties des actions -----------------------------------------------------------------


class NoInput(BaseModel):
    """Action sans paramètre."""


class DatasetIdInput(BaseModel):
    """Un jeu de données, par son identifiant."""

    dataset_id: str = Field(pattern=DATASET_ID_PATTERN, description="Identifiant du jeu (12 caractères hexadécimaux).")


class AlertsListInput(BaseModel):
    """Alertes, éventuellement limitées à un jeu."""

    dataset_id: str | None = Field(default=None, pattern=DATASET_ID_PATTERN, description="Jeu de données (facultatif).")


class TablePageInput(DatasetIdInput):
    """Page de lignes d'un jeu, au format `atelier-table/1`."""

    offset: int = Field(default=0, ge=0, description="Première ligne (0 = début).")
    limit: int = Field(default=TABLE_DEFAULT_LIMIT, ge=1, le=TABLE_MAX_LIMIT, description="Nombre de lignes.")


class UpsertTableInput(BaseModel):
    """Crée un jeu à partir d'une table d'échange, ou remplace les données du jeu qui porte déjà cette clé."""

    name: str = Field(min_length=1, max_length=200, description="Nom du jeu à sa création (inchangé ensuite).")
    key: str = Field(
        pattern=ATELIER_KEY_PATTERN,
        description="Clé externe stable choisie par l'appelant (ex. « nexus:rapport-hebdo ») : même clé = même jeu.",
    )
    table: AtelierTable

    @field_validator("name")
    @classmethod
    def _name(cls, name: str) -> str:
        name = name.strip()
        if not name:
            raise ValueError("Le nom est obligatoire.")
        if any(ord(c) < 32 for c in name):
            raise ValueError("Le nom contient un caractère de contrôle.")
        return name


class UpsertTableResult(BaseModel):
    """Résultat de `datasets.upsert_table`."""

    dataset_id: str
    name: str
    rows: int
    action: Literal["created", "updated"]


# --- Manifeste (§7.1) -----------------------------------------------------------------------------


class ManifestHttp(BaseModel):
    method: Literal["GET", "POST", "PUT", "PATCH", "DELETE"]
    path: str = Field(description="Chemin complet ; les paramètres `{nom}` sont pris dans l'entrée.")


class ManifestOutput(BaseModel):
    format: Literal["atelier-table/1", "json"]
    schema_: dict[str, Any] = Field(alias="schema", default_factory=dict)

    model_config = {"populate_by_name": True}


class ManifestAction(BaseModel):
    """Action qu'un workflow peut exécuter."""

    id: str = Field(pattern=ACTION_ID_PATTERN)
    label: str
    description: str
    kind: Literal["read", "write", "destructive"]
    http: ManifestHttp | None = None
    mcp_tool: str | None = None
    input_schema: dict[str, Any]
    output: ManifestOutput
    idempotency: Literal["header", "field", "natural", "none"]

    @model_validator(mode="after")
    def _one_transport(self) -> "ManifestAction":
        if (self.http is None) == (self.mcp_tool is None):
            raise ValueError("Une action a exactement un transport : `http` ou `mcp_tool`.")
        return self


class ManifestEvent(BaseModel):
    type: str = Field(pattern=EVENT_TYPE_PATTERN)
    label: str
    data_schema: dict[str, Any]


class AtelierManifest(BaseModel):
    contract: Literal["atelier-node/1"] = CONTRACT
    app: Literal["viz", "projets", "tab"]
    name: str
    version: str
    transport: Literal["http", "mcp"]
    actions: list[ManifestAction]
    events: list[ManifestEvent]


# --- Événements (§7.3) ----------------------------------------------------------------------------


class EventSubject(BaseModel):
    kind: str
    id: str
    label: str | None = None


class AtelierEvent(BaseModel):
    seq: int = Field(ge=1)
    type: str
    at: str = Field(description="Horodatage ISO 8601 avec fuseau.")
    subject: EventSubject
    data: dict[str, Any] = Field(default_factory=dict)


class AtelierEventsPage(BaseModel):
    """Réponse de `GET /api/atelier/events`."""

    events: list[AtelierEvent]
    next: int = Field(description="Dernier `seq` rendu (ou `since` s'il n'y a rien).")
    oldest: int = Field(description="Plus ancien `seq` encore conservé.")
    gap: bool = Field(default=False, description="Des événements postérieurs à `since` ont été perdus : relire l'état.")


# `data` des événements d'Atelier Viz : identifiants, libellés, statuts et nombres agrégés — jamais de lignes.

RefreshTrigger = Literal["manual", "schedule"]


class DatasetCreatedData(BaseModel):
    name: str
    rows: int
    origin: str = Field(
        description="Provenance : « file » (fichier ou exemple), type de connexion (« sqlite », « atelier_tab »…) "
        "ou « atelier-table » (table reçue d'un workflow)."
    )
    format: str = Field(description="Format enregistré du jeu (csv, xlsx, json, type de connexion, atelier_table).")
    key: str | None = Field(default=None, description="Clé externe d'une table reçue d'un workflow.")


class DatasetRefreshedData(BaseModel):
    rows: int
    trigger: RefreshTrigger
    source: Literal["connection", "atelier-table"] = Field(
        default="connection", description="Connexion relue, ou table reçue d'un workflow (`datasets.upsert_table`)."
    )


class DatasetRefreshFailedData(BaseModel):
    trigger: RefreshTrigger
    message: str
    status: Literal["error", "skipped", "interrupted"] = Field(
        default="error",
        description="error : échec ; skipped : non exécutée (ex. hors ligne) ; interrupted : arrêt de l'application.",
    )


class DatasetDeletedData(BaseModel):
    pass


class AlertValue(BaseModel):
    key: str = Field(description="Valeur de la dimension.")
    value: float | None


class AlertTriggeredData(BaseModel):
    dataset_id: str
    value: float | None
    comparison: Comparison
    threshold: float
    basis: AlertBasis = "value"
    dimension: str | None = Field(default=None, description="Alerte « pour chaque » : dimension évaluée.")
    values: list[AlertValue] | None = Field(default=None, description="Alerte « pour chaque » : valeurs déclenchées.")


class ReportSavedData(BaseModel):
    pages: int


EVENT_TYPES: dict[str, tuple[str, str, type[BaseModel]]] = {
    "viz.dataset.created": ("Jeu de données créé", "dataset", DatasetCreatedData),
    "viz.dataset.refreshed": ("Jeu actualisé", "dataset", DatasetRefreshedData),
    "viz.dataset.refresh_failed": ("Actualisation en échec", "dataset", DatasetRefreshFailedData),
    "viz.dataset.deleted": ("Jeu de données supprimé", "dataset", DatasetDeletedData),
    "viz.alert.triggered": ("Alerte déclenchée", "alert", AlertTriggeredData),
    "viz.report.saved": ("Rapport enregistré", "report", ReportSavedData),
}
"""Types d'événements publiés par Atelier Viz : libellé, `subject.kind`, schéma de `data`."""
