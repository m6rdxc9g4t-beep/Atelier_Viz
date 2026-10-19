"""Synchronisation des rapports avec un dépôt GitHub. Miroir TypeScript : frontend/src/types/github.ts.

Seuls les fichiers JSON des rapports sont envoyés : jamais les tables des jeux, ni la base DuckDB.
Un rapport peut toutefois recopier des valeurs des données (filtres, sélections des segments, signets)
et des adresses de webhook : `strip_private` (activé par défaut) les retire avant l'envoi
(`app/services/report_privacy.py`). Le jeton est rangé dans le trousseau ; l'API ne renvoie que `has_token`.
"""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, SecretStr, field_validator

Resolution = Literal["local", "remote", "copy"]
LocalState = Literal["new", "modified", "synced"]


class GitHubConfig(BaseModel):
    """Dépôt cible : `owner/repo`, branche, dossier des rapports."""

    repo: str = Field(pattern=r"^[A-Za-z0-9-]{1,39}/[A-Za-z0-9._-]{1,100}$", description="« propriétaire/dépôt ».")
    branch: str = Field(default="main", min_length=1, max_length=200, pattern=r"^[A-Za-z0-9._/-]+$")
    folder: str = Field(default="atelier-viz/rapports", max_length=200)
    strip_private: bool = Field(
        default=True,
        description=(
            "Retirer avant l'envoi les filtres, sélections, chemins d'exploration et adresses de webhook "
            "(valeurs des données, secrets possibles) ; à la récupération, ces champs restent ceux du poste."
        ),
    )

    @field_validator("folder")
    @classmethod
    def _folder(cls, value: str) -> str:
        folder = value.strip().strip("/")
        parts = folder.split("/") if folder else []
        if any(p in {"", ".", ".."} or p.startswith(".git") for p in parts):
            raise ValueError("Dossier invalide : pas de « .. », de « .git » ni de segment vide.")
        if any(c in folder for c in '\\:*?"<>|'):
            raise ValueError("Dossier invalide : caractères interdits.")
        return folder

    @field_validator("branch")
    @classmethod
    def _branch(cls, value: str) -> str:
        if value.startswith("/") or value.endswith("/") or ".." in value or value.endswith(".lock"):
            raise ValueError("Nom de branche invalide.")
        return value

    @property
    def owner_repo(self) -> tuple[str, str]:
        owner, name = self.repo.split("/", 1)
        return owner, name

    def same_target(self, other: "GitHubConfig | None") -> bool:
        """Même dépôt, branche et dossier (l'option de nettoyage ne change pas la base de comparaison)."""
        return other is not None and (self.repo, self.branch, self.folder) == (other.repo, other.branch, other.folder)


class GitHubConfigInput(GitHubConfig):
    """Enregistrement de la configuration ; `token` absent = inchangé, vide = effacé."""

    token: SecretStr | None = Field(default=None, description="Jeton d'accès (contents: read/write). Jamais renvoyé.")


class SyncRecord(BaseModel):
    """Empreintes (sha de blob Git) d'un rapport à la dernière synchronisation : base de la détection de conflit."""

    remote: str
    local: str
    at: datetime


class SyncEvent(BaseModel):
    at: datetime
    summary: str
    commit_url: str | None = None


class ReportSyncState(BaseModel):
    """État local d'un rapport par rapport à la dernière synchronisation (calculé sans réseau)."""

    id: str
    name: str
    updated_at: datetime
    state: LocalState


class GitHubState(BaseModel):
    """Configuration (sans jeton), état des rapports, dernières opérations."""

    config: GitHubConfig | None = None
    has_token: bool = False
    token_from_env: bool = Field(default=False, description="Jeton fourni par GITHUB_TOKEN (backend/.env).")
    online: bool = False
    account: str | None = None
    repo_private: bool | None = Field(default=None, description="Visibilité lue au dernier test (None = inconnue).")
    last_push: SyncEvent | None = None
    last_pull: SyncEvent | None = None
    reports: list[ReportSyncState] = Field(default_factory=list)


class GitHubTest(BaseModel):
    ok: bool
    message: str
    account: str | None = None
    can_push: bool | None = None
    default_branch: str | None = None
    repo_url: str | None = None
    private: bool | None = Field(default=None, description="Dépôt privé ; False = public (voir `warning`).")
    warning: str | None = Field(default=None, description="Avertissement (dépôt public).")


class Conflict(BaseModel):
    """Rapport modifié des deux côtés depuis la dernière synchronisation : rien n'est écrasé sans choix explicite."""

    id: str
    name: str
    local_updated_at: datetime | None = None
    remote_name: str | None = None
    remote_updated_at: datetime | None = None


class PushRequest(BaseModel):
    report_ids: list[str] | None = Field(default=None, max_length=500, description="Absent = tous les rapports.")
    message: str | None = Field(default=None, max_length=500)
    resolutions: dict[str, Literal["local"]] = Field(
        default_factory=dict, description="Conflits : « local » = écraser la version du dépôt."
    )


class PushResult(BaseModel):
    commit_sha: str | None = None
    commit_url: str | None = None
    pushed: list[str] = Field(default_factory=list, description="Noms des rapports envoyés.")
    unchanged: int = 0
    remote_newer: list[str] = Field(default_factory=list, description="Plus récents sur GitHub : à récupérer.")
    conflicts: list[Conflict] = Field(default_factory=list)
    message: str


class PullRequest(BaseModel):
    resolutions: dict[str, Resolution] = Field(
        default_factory=dict,
        description=(
            "Conflits : « remote » = prendre GitHub, « local » = garder ce poste, « copy » = importer une copie."
        ),
    )


class SkippedFile(BaseModel):
    path: str
    reason: str


class PullResult(BaseModel):
    imported: list[str] = Field(default_factory=list)
    updated: list[str] = Field(default_factory=list)
    copies: list[str] = Field(default_factory=list)
    kept_local: list[str] = Field(default_factory=list)
    unchanged: int = 0
    conflicts: list[Conflict] = Field(default_factory=list)
    skipped: list[SkippedFile] = Field(default_factory=list)
    message: str
