"""Synchronisation des rapports avec un dépôt GitHub (API REST, httpx).

- **En ligne uniquement** : toute opération réseau est refusée hors ligne (HTTP 403, message en français).
- **Rapports uniquement** : les fichiers `<id>.json` des rapports sont envoyés ; jamais les données des jeux,
  la base DuckDB, les connexions ni les secrets.
- Jeton dans le trousseau du système (`connectors/secrets.py`, clé `github:token`), sinon `GITHUB_TOKEN` ;
  jamais dans `data/github.json`, les journaux ou les réponses API.
- **Envoyer** : un seul commit par envoi via l'API Git Data (arbre → commit → mise à jour de la branche,
  sans forcer). **Récupérer** : import des rapports du dossier.
- **Conflits** : on garde, pour chaque rapport, l'empreinte Git (sha de blob) du fichier distant et du
  fichier local à la dernière synchronisation. Modifié des deux côtés → conflit signalé, rien n'est écrasé
  sans choix explicite (garder ce poste, prendre GitHub, ou importer une copie).
- Méthodes synchrones (réseau, disque) : à appeler via `asyncio.to_thread`.
"""

import base64
import hashlib
import json
import os
import re
import threading
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx
from pydantic import BaseModel, Field, ValidationError

from app.schemas.github import (
    Conflict,
    GitHubConfig,
    GitHubConfigInput,
    GitHubState,
    GitHubTest,
    PullRequest,
    PullResult,
    PushRequest,
    PushResult,
    ReportSyncState,
    SkippedFile,
    SyncEvent,
    SyncRecord,
)
from app.schemas.report import Report
from app.services.connectors.secrets import SecretBackend
from app.services.reports import ReportRepository

API = "https://api.github.com"
TOKEN_KEY = "github:token"
_FILE_RE = re.compile(r"^([0-9a-f]{12})\.json$")
MAX_REPORT_BYTES = 10_000_000


class GitHubError(Exception):
    """Erreur présentable (message en français) avec son code HTTP."""

    def __init__(self, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def report_bytes(report: Report) -> bytes:
    """Contenu du fichier d'un rapport (même forme que sur le disque, fin de ligne finale)."""
    return (json.dumps(report.model_dump(mode="json"), ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def blob_sha(content: bytes) -> str:
    """Empreinte Git d'un fichier (`git hash-object`) : comparée au `sha` renvoyé par GitHub sans télécharger."""
    return hashlib.sha1(b"blob %d\0" % len(content) + content, usedforsecurity=False).hexdigest()


class _Stored(BaseModel):
    """Contenu de `data/github.json` (aucun secret)."""

    config: GitHubConfig | None = None
    account: str | None = None
    records: dict[str, SyncRecord] = Field(default_factory=dict)
    last_push: SyncEvent | None = None
    last_pull: SyncEvent | None = None


class GitHubSync:
    """Configuration, envoi et récupération des rapports."""

    def __init__(
        self,
        path: Path,
        reports: ReportRepository,
        secrets: SecretBackend,
        is_online: Callable[[], bool],
        env_token: Callable[[], str | None] = lambda: None,
        http_factory: Callable[[], httpx.Client] | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.path = path
        self.reports = reports
        self.secrets = secrets
        self.is_online = is_online
        self.env_token = env_token
        self.http_factory = http_factory or (lambda: httpx.Client(timeout=30.0))
        self.clock = clock
        self._lock = threading.Lock()  # une opération GitHub à la fois

    # --- Persistance ----------------------------------------------------------------------------

    def _read(self) -> _Stored:
        try:
            return _Stored.model_validate_json(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, ValueError):
            return _Stored()

    def _write(self, stored: _Stored) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(stored.model_dump_json(indent=2), encoding="utf-8")
        os.replace(tmp, self.path)

    def _token(self) -> str | None:
        return self.secrets.get(TOKEN_KEY) or self.env_token() or None

    # --- Configuration --------------------------------------------------------------------------

    def state(self) -> GitHubState:
        """Configuration (sans jeton) et état local de chaque rapport (sans réseau)."""
        stored = self._read()
        reports = []
        for r in self.reports.all():
            rec = stored.records.get(r.id)
            local = blob_sha(report_bytes(r))
            state = "new" if rec is None else ("synced" if rec.local == local else "modified")
            reports.append(ReportSyncState(id=r.id, name=r.name, updated_at=r.updated_at, state=state))
        reports.sort(key=lambda x: x.updated_at, reverse=True)
        return GitHubState(
            config=stored.config,
            has_token=bool(self._token()),
            token_from_env=not self.secrets.get(TOKEN_KEY) and bool(self.env_token()),
            online=self.is_online(),
            account=stored.account,
            last_push=stored.last_push,
            last_pull=stored.last_pull,
            reports=reports,
        )

    def configure(self, data: GitHubConfigInput) -> GitHubState:
        """Enregistre le dépôt ; le jeton va au trousseau (absent = inchangé, vide = effacé)."""
        stored = self._read()
        config = GitHubConfig(repo=data.repo, branch=data.branch, folder=data.folder)
        if stored.config != config:
            stored.records = {}  # autre dépôt / branche / dossier : nouvelle base de comparaison
            stored.last_push = stored.last_pull = None
        stored.config = config
        if data.token is not None:
            token = data.token.get_secret_value().strip()
            if token:
                self.secrets.set(TOKEN_KEY, token)
            else:
                self.secrets.delete(TOKEN_KEY)
            stored.account = None
        self._write(stored)
        return self.state()

    def disconnect(self) -> GitHubState:
        """Oublie la configuration, l'état de synchronisation et le jeton."""
        self.secrets.delete(TOKEN_KEY)
        self._write(_Stored())
        return self.state()

    # --- Réseau ---------------------------------------------------------------------------------

    def _ready(self) -> tuple[GitHubConfig, str]:
        if not self.is_online():
            raise GitHubError(
                "Mode hors ligne : la synchronisation GitHub passe par Internet. Activez le mode « En ligne ».", 403
            )
        config = self._read().config
        if config is None:
            raise GitHubError("Configurez d'abord le dépôt GitHub (propriétaire/dépôt, branche, dossier).", 412)
        token = self._token()
        if not token:
            raise GitHubError("Aucun jeton GitHub : collez un jeton d'accès dans les réglages GitHub.", 412)
        return config, token

    @contextmanager
    def _client(self, token: str) -> Iterator["_Api"]:
        with self.http_factory() as http:
            yield _Api(http, token)

    def test(self) -> GitHubTest:
        """Vérifie le jeton et l'accès au dépôt (droit d'écriture, branche par défaut)."""
        config, token = self._ready()
        owner, name = config.owner_repo
        with self._client(token) as api:
            try:
                user = api.get("/user")
                repo = api.get(f"/repos/{owner}/{name}")
            except GitHubError as exc:
                return GitHubTest(ok=False, message=exc.message)
            account = str(user.get("login") or "")
            can_push = bool((repo.get("permissions") or {}).get("push"))
            branch_ok = True
            try:
                api.get(f"/repos/{owner}/{name}/branches/{quote(config.branch, safe='')}")
            except GitHubError as exc:
                if exc.status_code != 404:
                    raise
                branch_ok = False
        with self._lock:
            stored = self._read()
            stored.account = account or None
            self._write(stored)
        if not can_push:
            message = f"Connecté en tant que {account}, mais ce jeton ne peut pas écrire dans {config.repo}."
        elif not branch_ok:
            message = (
                f"Connecté en tant que {account}. La branche « {config.branch} » n'existe pas encore : "
                f"elle sera créée depuis « {repo.get('default_branch')} » au premier envoi."
            )
        else:
            message = f"Connecté en tant que {account} : {config.repo} ({config.branch}) accessible en écriture."
        return GitHubTest(
            ok=can_push,
            message=message,
            account=account or None,
            can_push=can_push,
            default_branch=repo.get("default_branch"),
            repo_url=repo.get("html_url"),
        )

    def _path(self, config: GitHubConfig, report_id: str) -> str:
        return f"{config.folder}/{report_id}.json" if config.folder else f"{report_id}.json"

    def _remote_files(self, api: "_Api", config: GitHubConfig, ref: str) -> dict[str, str]:
        """Rapports présents dans le dossier du dépôt : identifiant → sha du blob."""
        owner, name = config.owner_repo
        folder = quote(config.folder, safe="/")
        try:
            items = api.get(f"/repos/{owner}/{name}/contents/{folder}", params={"ref": ref})
        except GitHubError as exc:
            if exc.status_code == 404:
                return {}  # dossier absent : rien encore
            raise
        if not isinstance(items, list):
            raise GitHubError(f"« {config.folder} » est un fichier dans le dépôt, pas un dossier.")
        out: dict[str, str] = {}
        for item in items:
            match = _FILE_RE.match(str(item.get("name", "")))
            if match and item.get("type") == "file":
                out[match.group(1)] = str(item["sha"])
        return out

    def _head(self, api: "_Api", config: GitHubConfig, create: bool) -> tuple[str, str] | None:
        """(sha du commit de tête, sha de son arbre) de la branche ; la crée depuis la branche par défaut au besoin."""
        owner, name = config.owner_repo
        branch = quote(config.branch, safe="/")
        try:
            ref = api.get(f"/repos/{owner}/{name}/git/ref/heads/{branch}")
        except GitHubError as exc:
            if exc.status_code == 409:
                raise GitHubError(
                    f"Le dépôt {config.repo} est vide : créez-y un premier commit (un README suffit) puis réessayez."
                ) from exc
            if exc.status_code != 404:
                raise
            if not create:
                return None
            repo = api.get(f"/repos/{owner}/{name}")
            default = quote(str(repo.get("default_branch") or "main"), safe="/")
            base = api.get(f"/repos/{owner}/{name}/git/ref/heads/{default}")
            ref = api.post(
                f"/repos/{owner}/{name}/git/refs",
                {"ref": f"refs/heads/{config.branch}", "sha": base["object"]["sha"]},
            )
        commit_sha = str(ref["object"]["sha"])
        commit = api.get(f"/repos/{owner}/{name}/git/commits/{commit_sha}")
        return commit_sha, str(commit["tree"]["sha"])

    # --- Envoyer --------------------------------------------------------------------------------

    def push(self, req: PushRequest) -> PushResult:
        """Envoie les rapports (tous ou une sélection) en un seul commit ; signale les conflits sans écraser."""
        config, token = self._ready()
        owner, name = config.owner_repo
        with self._lock, self._client(token) as api:
            stored = self._read()
            head = self._head(api, config, create=True)
            assert head is not None
            commit_sha, tree_sha = head
            remote = self._remote_files(api, config, commit_sha)
            wanted = set(req.report_ids) if req.report_ids is not None else None
            local = [r for r in self.reports.all() if wanted is None or r.id in wanted]

            to_push: list[tuple[Report, bytes, str]] = []
            unchanged, remote_newer, conflicts = 0, [], []
            for report in local:
                content = report_bytes(report)
                if len(content) > MAX_REPORT_BYTES:
                    raise GitHubError(f"Rapport « {report.name} » trop volumineux pour être envoyé.", 413)
                sha = blob_sha(content)
                remote_sha = remote.get(report.id)
                rec = stored.records.get(report.id)
                if remote_sha == sha:
                    unchanged += 1
                    stored.records[report.id] = SyncRecord(remote=sha, local=sha, at=self.clock())
                    continue
                remote_changed = remote_sha is not None and (rec is None or rec.remote != remote_sha)
                local_changed = rec is None or rec.local != sha
                if not remote_changed and not local_changed:
                    unchanged += 1  # même contenu, mise en forme différente (import) : pas de commit inutile
                    continue
                if remote_changed and not local_changed:
                    remote_newer.append(report.name)  # GitHub a une version plus récente : à récupérer
                    continue
                if remote_changed and req.resolutions.get(report.id) != "local":
                    conflicts.append(Conflict(id=report.id, name=report.name, local_updated_at=report.updated_at))
                    continue
                to_push.append((report, content, sha))

            if not to_push:
                self._write(stored)
                parts = ["Rien à envoyer : le dépôt est à jour." if not (conflicts or remote_newer) else "Rien envoyé."]
                if remote_newer:
                    parts.append(f"{len(remote_newer)} rapport(s) plus récent(s) sur GitHub : récupérez-les.")
                if conflicts:
                    parts.append(f"{len(conflicts)} conflit(s) à résoudre.")
                return PushResult(
                    unchanged=unchanged, remote_newer=remote_newer, conflicts=conflicts, message=" ".join(parts)
                )

            names = [r.name for r, _, _ in to_push]
            message = (req.message or "").strip() or _commit_message(names)
            tree = api.post(
                f"/repos/{owner}/{name}/git/trees",
                {
                    "base_tree": tree_sha,
                    "tree": [
                        {
                            "path": self._path(config, r.id),
                            "mode": "100644",
                            "type": "blob",
                            "content": content.decode("utf-8"),
                        }
                        for r, content, _ in to_push
                    ],
                },
            )
            commit = api.post(
                f"/repos/{owner}/{name}/git/commits",
                {"message": message, "tree": tree["sha"], "parents": [commit_sha]},
            )
            try:
                api.patch(
                    f"/repos/{owner}/{name}/git/refs/heads/{quote(config.branch, safe='/')}",
                    {"sha": commit["sha"], "force": False},
                )
            except GitHubError as exc:
                if exc.status_code == 422:
                    raise GitHubError(
                        "La branche a changé sur GitHub pendant l'envoi : rien n'a été écrasé. Réessayez.", 409
                    ) from exc
                raise
            now = self.clock()
            for report, _, sha in to_push:
                stored.records[report.id] = SyncRecord(remote=sha, local=sha, at=now)
            commit_url = str(commit.get("html_url") or f"https://github.com/{config.repo}/commit/{commit['sha']}")
            summary = f"{len(to_push)} rapport(s) envoyé(s)"
            stored.last_push = SyncEvent(at=now, summary=summary, commit_url=commit_url)
            self._write(stored)
        text = f"{summary} en un commit."
        if remote_newer:
            text += f" {len(remote_newer)} rapport(s) plus récent(s) sur GitHub : récupérez-les."
        if conflicts:
            text += f" {len(conflicts)} conflit(s) non envoyé(s)."
        return PushResult(
            commit_sha=str(commit["sha"]),
            commit_url=commit_url,
            pushed=names,
            unchanged=unchanged,
            remote_newer=remote_newer,
            conflicts=conflicts,
            message=text,
        )

    # --- Récupérer ------------------------------------------------------------------------------

    def pull(self, req: PullRequest) -> PullResult:
        """Importe les rapports du dépôt ; un rapport modifié des deux côtés n'est jamais écrasé sans choix."""
        config, token = self._ready()
        owner, name = config.owner_repo
        result = PullResult(message="")
        with self._lock, self._client(token) as api:
            stored = self._read()
            head = self._head(api, config, create=False)
            if head is None:
                raise GitHubError(f"La branche « {config.branch} » n'existe pas dans {config.repo}.", 404)
            remote = self._remote_files(api, config, head[0])
            now = self.clock()
            for report_id, remote_sha in sorted(remote.items()):
                path = self._path(config, report_id)
                rec = stored.records.get(report_id)
                current = self.reports.get(report_id)
                local_sha = blob_sha(report_bytes(current)) if current else None
                if local_sha == remote_sha:
                    result.unchanged += 1
                    stored.records[report_id] = SyncRecord(remote=remote_sha, local=remote_sha, at=now)
                    continue
                if current is not None and rec is not None and rec.remote == remote_sha:
                    result.unchanged += 1  # rien de neuf sur GitHub (ce poste est peut-être plus récent : à envoyer)
                    continue
                try:
                    incoming = _parse_report(api.blob(owner, name, remote_sha), report_id)
                except GitHubError as exc:
                    result.skipped.append(SkippedFile(path=path, reason=exc.message))
                    continue
                if current is None:
                    self.reports.put(incoming)
                    stored.records[report_id] = self._record(incoming, remote_sha, now)
                    result.imported.append(incoming.name)
                    continue
                local_changed = rec is None or rec.local != local_sha
                choice = req.resolutions.get(report_id)
                if not local_changed or choice == "remote":
                    self.reports.put(incoming)
                    stored.records[report_id] = self._record(incoming, remote_sha, now)
                    result.updated.append(incoming.name)
                elif choice == "local":
                    # Ce poste l'emporte : la version GitHub devient la base, le prochain envoi la remplacera.
                    stored.records[report_id] = SyncRecord(remote=remote_sha, local=remote_sha, at=now)
                    result.kept_local.append(current.name)
                elif choice == "copy":
                    copy = incoming.model_copy(
                        update={"id": uuid.uuid4().hex[:12], "name": f"{incoming.name} (copie GitHub)"[:200]}
                    )
                    self.reports.put(copy)
                    stored.records[report_id] = SyncRecord(
                        remote=remote_sha, local=rec.local if rec else remote_sha, at=now
                    )
                    result.copies.append(copy.name)
                else:
                    result.conflicts.append(
                        Conflict(
                            id=report_id,
                            name=current.name,
                            local_updated_at=current.updated_at,
                            remote_name=incoming.name,
                            remote_updated_at=incoming.updated_at,
                        )
                    )
            done = len(result.imported) + len(result.updated) + len(result.copies)
            stored.last_pull = SyncEvent(at=now, summary=f"{done} rapport(s) récupéré(s)")
            self._write(stored)
        parts = [f"{done} rapport(s) récupéré(s)." if done else "Aucun rapport nouveau sur GitHub."]
        if result.conflicts:
            parts.append(f"{len(result.conflicts)} conflit(s) à résoudre : rien n'a été écrasé.")
        if result.skipped:
            parts.append(f"{len(result.skipped)} fichier(s) ignoré(s).")
        result.message = " ".join(parts)
        return result

    def _record(self, report: Report, remote_sha: str, now: datetime) -> SyncRecord:
        """Base de comparaison après écriture locale (le fichier local peut différer octet pour octet)."""
        written = self.reports.get(report.id) or report
        return SyncRecord(remote=remote_sha, local=blob_sha(report_bytes(written)), at=now)


def _commit_message(names: list[str]) -> str:
    shown = ", ".join(f"« {n} »" for n in names[:5])
    more = f" et {len(names) - 5} autre(s)" if len(names) > 5 else ""
    title = f"Atelier Viz : {len(names)} rapport(s) mis à jour"
    return f"{title}\n\n{shown}{more}.\nEnvoyé depuis Atelier Viz (rapports uniquement, aucune donnée)."


def _parse_report(content: bytes, report_id: str) -> Report:
    if len(content) > MAX_REPORT_BYTES:
        raise GitHubError("Fichier trop volumineux.")
    try:
        report = Report.model_validate_json(content)
    except ValidationError as exc:
        raise GitHubError(f"Rapport illisible (format Atelier Viz attendu) : {exc.errors()[0]['msg']}") from exc
    except ValueError as exc:
        raise GitHubError("Rapport illisible (JSON invalide).") from exc
    if report.id != report_id:
        raise GitHubError("L'identifiant du rapport ne correspond pas au nom du fichier.")
    return report


class _Api:
    """Appels REST GitHub avec messages d'erreur en français (le jeton n'apparaît jamais dans un message)."""

    def __init__(self, http: httpx.Client, token: str) -> None:
        self.http = http
        self.headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "Atelier-Viz",
        }

    def _send(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            response = self.http.request(method, f"{API}{path}", headers=self.headers, **kwargs)
        except httpx.HTTPError as exc:
            raise GitHubError(
                f"GitHub injoignable ({type(exc).__name__}) : vérifiez la connexion Internet.", 502
            ) from exc
        if response.is_success:
            return response.json() if response.content else {}
        detail = ""
        try:
            detail = str(response.json().get("message") or "")
        except ValueError:
            pass
        code = response.status_code
        if code == 401:
            raise GitHubError("Jeton GitHub refusé (expiré ou révoqué) : collez un nouveau jeton.", 401)
        if code == 403 and response.headers.get("x-ratelimit-remaining") == "0":
            raise GitHubError("Limite d'appels GitHub atteinte : réessayez dans quelques minutes.", 429)
        if code == 403:
            raise GitHubError(f"Accès refusé par GitHub ({detail or 'droits du jeton insuffisants'}).", 403)
        if code == 404:
            raise GitHubError("Introuvable sur GitHub : dépôt, branche ou dossier (ou jeton sans accès).", 404)
        raise GitHubError(f"GitHub a répondu {code}{f' : {detail}' if detail else ''}.", code)

    def get(self, path: str, params: dict[str, str] | None = None) -> Any:
        return self._send("GET", path, params=params)

    def post(self, path: str, body: dict[str, Any]) -> Any:
        return self._send("POST", path, json=body)

    def patch(self, path: str, body: dict[str, Any]) -> Any:
        return self._send("PATCH", path, json=body)

    def blob(self, owner: str, name: str, sha: str) -> bytes:
        data = self.get(f"/repos/{owner}/{name}/git/blobs/{sha}")
        if data.get("encoding") != "base64":
            raise GitHubError("Format de fichier inattendu.")
        return base64.b64decode(str(data.get("content", "")))
