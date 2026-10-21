"""Synchronisation des rapports avec un dépôt GitHub. Miroir TypeScript : frontend/src/types/github.ts.

Seuls les fichiers JSON des rapports sont envoyés : jamais les tables des jeux, ni la base DuckDB.
Un rapport peut toutefois recopier des valeurs des données (filtres, sélections des segments, signets)
et des adresses de webhook : `strip_private` (activé par défaut) les retire avant l'envoi
(`app/services/report_privacy.py`). Le jeton est rangé dans le trousseau ; l'API ne renvoie que `has_token`.
"""

from datetime import datetime
from typing import Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, Field, SecretStr, field_validator

DEFAULT_API = "https://api.github.com"
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
    api_url: str = Field(
        default=DEFAULT_API,
        max_length=300,
        description="API REST : https://api.github.com, ou GitHub Enterprise Server (https://<hôte>/api/v3).",
    )

    @field_validator("api_url")
    @classmethod
    def _api_url(cls, value: str) -> str:
        url = (value or DEFAULT_API).strip().rstrip("/")
        parts = urlsplit(url)
        loopback = parts.hostname in {"localhost", "127.0.0.1", "::1"}
        if parts.scheme != "https" and not (parts.scheme == "http" and loopback):
            raise ValueError("Adresse de l'API invalide : https:// obligatoire (le jeton y est envoyé).")
        if not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
            raise ValueError("Adresse de l'API invalide : ni identifiant, ni paramètre, ni ancre.")
        return url

    @property
    def web_url(self) -> str:
        """Site web correspondant (liens vers les commits) : github.com, ou l'hôte Enterprise."""
        parts = urlsplit(self.api_url)
        if parts.hostname == "api.github.com":
            return "https://github.com"
        return f"{parts.scheme}://{parts.netloc}"

    @property
    def enterprise(self) -> bool:
        return self.api_url != DEFAULT_API

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
        mine = (self.api_url, self.repo, self.branch, self.folder)
        return other is not None and mine == (other.api_url, other.repo, other.branch, other.folder)


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


class ReportVersion(BaseModel):
    """Un commit qui a modifié le fichier d'un rapport (historique GitHub)."""

    sha: str
    message: str = Field(description="Première ligne du message.")
    author: str | None = None
    date: datetime | None = None
    url: str | None = None


class ReportVersionDetail(BaseModel):
    """Contenu d'une version (aperçu avant restauration)."""

    sha: str
    name: str
    pages: list[str] = Field(default_factory=list, description="Noms des pages.")
    visuals: int = 0
    updated_at: datetime | None = None


class RestoreRequest(BaseModel):
    sha: str = Field(pattern=r"^[0-9a-f]{7,40}$")
    as_copy: bool = Field(default=False, description="Importer à côté (copie) au lieu de remplacer le rapport.")


class RestoreResult(BaseModel):
    report_id: str
    name: str
    message: str
