"""Connexions enregistrées et import / actualisation des jeux de données qui en proviennent.

- Définitions dans `data/connections.json` (écriture atomique), **sans secret** ;
  mots de passe et jetons Microsoft dans le trousseau du système (`secrets.py`).
- Hors ligne : seuls la machine et les réseaux privés sont joignables ; SharePoint Online exige
  le mode « En ligne » (HTTP 403 sinon).
- Méthodes synchrones (réseau, pilotes, pandas, DuckDB) : à appeler via `asyncio.to_thread`.
"""

import json
import os
import threading
import uuid
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, contextmanager
from datetime import UTC, datetime
from pathlib import Path

import httpx
import pandas as pd

from app.core.config import Settings
from app.schemas.connection import (
    SERVER_KINDS,
    SQL_KINDS,
    AuthStatus,
    Connection,
    ConnectionFields,
    ConnectionInput,
    ConnectorInfo,
    DatasetOrigin,
    DeviceCodeStart,
    ImportRequest,
    PreviewRequest,
    PreviewResult,
    SourceSpec,
    TableList,
    TableRef,
    TestResult,
)
from app.schemas.dataset import SourceFormat
from app.services.connectors import sql
from app.services.connectors.base import ConnectorError, check_server, preview_of
from app.services.connectors.secrets import SecretBackend
from app.services.connectors.sharepoint import PendingLogin, SharePointClient, Tokens
from app.services.data.parsing import DatasetError, detect_format, excel_sheets, read_table
from app.services.data.store import DatasetStore, StoredDataset

FILE_SUFFIXES = {".csv", ".tsv", ".txt", ".xlsx", ".json"}


class ConnectionService:
    """Registre des connexions et lecture des sources."""

    def __init__(
        self,
        path: Path,
        secrets: SecretBackend,
        settings: Settings,
        store: DatasetStore,
        is_online: Callable[[], bool],
        http_factory: Callable[[], httpx.Client] | None = None,
    ) -> None:
        self.path = path
        self.secrets = secrets
        self.settings = settings
        self.store = store
        self.is_online = is_online
        self.http_factory = http_factory or (lambda: httpx.Client(timeout=60.0))
        self._lock = threading.Lock()
        self._pending: dict[str, PendingLogin] = {}

    # --- Registre ---------------------------------------------------------------------------

    def _read(self) -> list[Connection]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return []
        return [Connection.model_validate(c) for c in raw if isinstance(c, dict)]

    def _write(self, items: list[Connection]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        fields = {"has_password", "signed_in", "account"}  # recalculés à la lecture
        tmp.write_text(
            json.dumps([c.model_dump(mode="json", exclude=fields) for c in items], ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        os.replace(tmp, self.path)

    def _decorate(self, c: Connection) -> Connection:
        update: dict[str, object] = {"has_password": bool(self.secrets.get(self._key(c.id, "password")))}
        if c.kind == "sharepoint":
            tokens = self._tokens(c.id)
            update |= {"signed_in": tokens is not None, "account": tokens.account if tokens else None}
        return c.model_copy(update=update)

    def list_connections(self) -> list[Connection]:
        return [self._decorate(c) for c in self._read()]

    def get(self, connection_id: str) -> Connection:
        for c in self._read():
            if c.id == connection_id:
                return self._decorate(c)
        raise ConnectorError(f"Connexion « {connection_id} » introuvable.", 404)

    def create(self, data: ConnectionInput) -> Connection:
        conn = Connection(
            id=uuid.uuid4().hex[:12], created_at=datetime.now(UTC), **data.model_dump(exclude={"password"})
        )
        with self._lock:
            items = self._read()
            items.append(conn)
            self._write(items)
        if data.password is not None and data.password.get_secret_value():
            self.secrets.set(self._key(conn.id, "password"), data.password.get_secret_value())
        return self.get(conn.id)

    def update(self, connection_id: str, data: ConnectionInput) -> Connection:
        with self._lock:
            items = self._read()
            current = next((c for c in items if c.id == connection_id), None)
            if current is None:
                raise ConnectorError(f"Connexion « {connection_id} » introuvable.", 404)
            if current.kind != data.kind:
                raise ConnectorError("Le type d'une connexion ne peut pas changer : créez-en une nouvelle.")
            updated = current.model_copy(update=data.model_dump(exclude={"password"}))
            self._write([updated if c.id == connection_id else c for c in items])
        if data.password is not None:
            # Chaîne vide = mot de passe effacé ; absent = inchangé.
            if data.password.get_secret_value():
                self.secrets.set(self._key(connection_id, "password"), data.password.get_secret_value())
            else:
                self.secrets.delete(self._key(connection_id, "password"))
        if current.kind == "sharepoint" and (current.tenant, current.client_id) != (updated.tenant, updated.client_id):
            self.secrets.delete(self._key(connection_id, "msgraph"))
        return self.get(connection_id)

    def delete(self, connection_id: str) -> None:
        with self._lock:
            items = self._read()
            if not any(c.id == connection_id for c in items):
                raise ConnectorError(f"Connexion « {connection_id} » introuvable.", 404)
            self._write([c for c in items if c.id != connection_id])
        for what in ("password", "msgraph"):
            self.secrets.delete(self._key(connection_id, what))
        self._pending.pop(connection_id, None)

    @staticmethod
    def _key(connection_id: str, what: str) -> str:
        return f"connection:{connection_id}:{what}"

    # --- Types de sources -------------------------------------------------------------------

    def connectors(self) -> list[ConnectorInfo]:
        infos = [
            ConnectorInfo(
                kind=d.kind,
                label=d.label,
                description=d.description,
                driver_installed=d.driver_installed(),
                install_hint=None if d.driver_installed() else d.install_hint,
                default_port=d.default_port,
            )
            for d in sql.DIALECTS.values()
        ]
        infos.append(
            ConnectorInfo(
                kind="file",
                label="Fichier synchronisé",
                description=(
                    "CSV, Excel ou JSON d'un dossier de la machine : OneDrive, SharePoint ou Teams synchronisés, "
                    "partage réseau"
                ),
                driver_installed=True,
            )
        )
        infos.append(
            ConnectorInfo(
                kind="sharepoint",
                label="SharePoint Online",
                description="Fichier d'une bibliothèque ou liste SharePoint, via votre compte Microsoft 365",
                driver_installed=True,
                needs_online=True,
                configured=bool(self.settings.sharepoint_client_id),
            )
        )
        return infos

    # --- Lecture ------------------------------------------------------------------------------

    def _guard(self, cfg: ConnectionFields) -> None:
        """Politique réseau : hors ligne, pas d'Internet."""
        if cfg.kind in SERVER_KINDS:
            check_server(cfg.host or "", self.is_online())
        elif cfg.kind == "sharepoint" and not self.is_online():
            raise ConnectorError(
                "Mode hors ligne : SharePoint Online est sur Internet. "
                "Activez le mode « En ligne » pour vous y connecter.",
                403,
            )

    def _password(self, cfg: ConnectionFields, password: str | None, connection_id: str | None) -> str | None:
        if password is not None:
            return password
        return self.secrets.get(self._key(connection_id, "password")) if connection_id else None

    def _sql(
        self, cfg: ConnectionFields, password: str | None = None, connection_id: str | None = None
    ) -> AbstractContextManager[sql.DbConnection]:
        self._guard(cfg)
        return sql.connect(
            cfg,
            self._password(cfg, password, connection_id),
            self.settings.connector_login_timeout_seconds,
            self.settings.connector_query_timeout_seconds,
        )

    def _file(self, cfg: ConnectionFields) -> Path:
        path = Path(cfg.path or "").expanduser()
        if path.suffix.lower() not in FILE_SUFFIXES:
            raise ConnectorError("Fichier CSV, XLSX ou JSON attendu.")
        if not path.is_file():
            raise ConnectorError(f"Fichier introuvable : {path} (est-il synchronisé sur cette machine ?)")
        size = path.stat().st_size
        if size > self.settings.connector_max_file_mb * 1_000_000:
            raise ConnectorError(
                f"Fichier trop volumineux ({size // 1_000_000} Mo, max {self.settings.connector_max_file_mb} Mo).", 413
            )
        return path

    def _tokens(self, connection_id: str) -> Tokens | None:
        raw = self.secrets.get(self._key(connection_id, "msgraph"))
        try:
            return Tokens.loads(raw) if raw else None
        except (ValueError, KeyError):
            return None

    def _sharepoint(self, cfg: Connection, http: httpx.Client) -> SharePointClient:
        client_id = cfg.client_id or self.settings.sharepoint_client_id
        key = self._key(cfg.id, "msgraph")

        def save(raw: str | None) -> None:
            if raw is None:
                self.secrets.delete(key)
            else:
                self.secrets.set(key, raw)

        return SharePointClient(
            tenant=cfg.tenant or self.settings.sharepoint_tenant,
            client_id=client_id or "",
            load_tokens=lambda: self.secrets.get(key),
            save_tokens=save,
            http=http,
            max_file_bytes=self.settings.connector_max_file_mb * 1_000_000,
        )

    @contextmanager
    def _sharepoint_ready(self, cfg: Connection) -> Iterator[SharePointClient]:
        """Client Graph prêt (mode en ligne, application configurée), fermé à la sortie."""
        self._guard(cfg)
        if not (cfg.client_id or self.settings.sharepoint_client_id):
            raise ConnectorError(
                "SharePoint n'est pas configuré : renseignez l'identifiant d'application Entra ID "
                "(SHAREPOINT_CLIENT_ID dans backend/.env, ou dans la connexion). Voir README, « Connecteurs ».",
                412,
            )
        with self.http_factory() as http:
            yield self._sharepoint(cfg, http)

    def test(self, cfg: ConnectionFields, password: str | None = None, connection_id: str | None = None) -> TestResult:
        """Essaie la connexion (avant ou après enregistrement)."""
        try:
            if cfg.kind in SQL_KINDS:
                with self._sql(cfg, password, connection_id) as conn:
                    server = sql.version(conn, cfg)
                return TestResult(ok=True, message="Connexion réussie.", server=server)
            if cfg.kind == "file":
                path = self._file(cfg)
                return TestResult(ok=True, message=f"Fichier trouvé ({path.stat().st_size // 1024} Ko).")
            if not connection_id:
                return TestResult(ok=False, message="Enregistrez la connexion puis connectez-vous à Microsoft 365.")
            with self._sharepoint_ready(self.get(connection_id)) as sp:
                account = sp.test()
            return TestResult(ok=True, message=f"Connecté à Microsoft 365 ({account}).")
        except ConnectorError as exc:
            if exc.status_code == 403:  # mode hors ligne ou accès refusé : refus explicite
                raise
            return TestResult(ok=False, message=exc.message)

    def tables(self, connection_id: str, url: str | None = None) -> TableList:
        cfg = self.get(connection_id)
        if cfg.kind in SQL_KINDS:
            with self._sql(cfg, connection_id=connection_id) as conn:
                tables, truncated = sql.list_tables(conn, cfg)
            return TableList(tables=tables, truncated=truncated)
        if cfg.kind == "file":
            path = self._file(cfg)
            if path.suffix.lower() != ".xlsx":
                return TableList(tables=[])
            try:
                return TableList(tables=[TableRef(name=s, kind="sheet") for s in excel_sheets(path.read_bytes())])
            except DatasetError as exc:
                raise ConnectorError(str(exc)) from exc
        if not url:
            return TableList(tables=[])
        with self._sharepoint_ready(cfg) as sp:
            return TableList(tables=sp.sheets(url))

    def _fetch(self, cfg: Connection, spec: SourceSpec, limit: int) -> tuple[pd.DataFrame, bool, str, SourceFormat]:
        """(données, tronqué, nom suggéré, format) pour une source."""
        if cfg.kind in SQL_KINDS:
            dialect = sql.DIALECTS[cfg.kind]
            if spec.query and spec.query.strip():
                query = sql.check_query(spec.query)
                with self._sql(cfg, connection_id=cfg.id) as conn:
                    df, truncated = sql.run(conn, query, limit)
                return df, truncated, f"{cfg.name} (requête)", cfg.kind
            if spec.table is None:
                raise ConnectorError("Choisissez une table ou écrivez une requête.")
            with self._sql(cfg, connection_id=cfg.id) as conn:
                df, truncated = sql.run(conn, dialect.select_table(spec.table, limit + 1), limit)
            name = (
                f"{spec.table.schema_}.{spec.table.name}"
                # Schéma par défaut (dbo, public, base MySQL courante) : nom de table seul.
                if spec.table.schema_ and spec.table.schema_ not in {"dbo", "public", cfg.database}
                else spec.table.name
            )
            return df, truncated, name, cfg.kind
        if cfg.kind == "file":
            path = self._file(cfg)
            sheet = spec.table.name if spec.table else None
            try:
                df, fmt = read_table(path.name, path.read_bytes(), sheet)
            except DatasetError as exc:
                raise ConnectorError(str(exc)) from exc
            return df.head(limit), len(df) > limit, path.name if not sheet else f"{path.stem} — {sheet}", fmt
        if not spec.url:
            raise ConnectorError("Collez le lien SharePoint du fichier ou de la liste.")
        with self._sharepoint_ready(cfg) as sp:
            df, truncated, name = sp.fetch(spec.url, spec.table.name if spec.table else None, limit)
        try:
            fmt: SourceFormat = detect_format(name)
        except DatasetError:
            fmt = "sharepoint"
        return df, truncated, name, fmt

    def preview(self, connection_id: str, req: PreviewRequest) -> PreviewResult:
        df, truncated, _, _ = self._fetch(self.get(connection_id), req, req.limit)
        return preview_of(df, truncated)

    def import_dataset(self, connection_id: str, req: ImportRequest) -> StoredDataset:
        cfg = self.get(connection_id)
        max_rows = min(req.max_rows or self.settings.connector_max_rows, self.settings.connector_max_rows)
        df, truncated, suggested, fmt = self._fetch(cfg, req, max_rows)
        if df.empty or not len(df.columns):
            raise ConnectorError("La source ne renvoie aucune ligne : rien à importer.")
        origin = self._origin(cfg, req, max_rows if req.max_rows else None, truncated)
        name = (req.name or "").strip() or suggested
        return self.store.add(name, fmt, df, origin)

    def refresh(self, dataset: StoredDataset) -> StoredDataset:
        """Relit la source d'un jeu importé depuis une connexion et remplace ses données."""
        origin = dataset.profile_data.origin
        if origin is None:
            raise ConnectorError(
                "Ce jeu de données a été importé depuis un fichier : réimportez-le pour le mettre à jour."
            )
        try:
            cfg = self.get(origin.connection_id)
        except ConnectorError as exc:
            raise ConnectorError(
                f"La connexion « {origin.connection_name} » a été supprimée : actualisation impossible.", 409
            ) from exc
        spec = SourceSpec(table=origin.table, query=origin.query, url=origin.url)
        max_rows = min(origin.max_rows or self.settings.connector_max_rows, self.settings.connector_max_rows)
        df, truncated, _, _ = self._fetch(cfg, spec, max_rows)
        if df.empty or not len(df.columns):
            raise ConnectorError("La source ne renvoie plus aucune ligne : données conservées.")
        return self.store.replace_data(dataset, df, self._origin(cfg, spec, origin.max_rows, truncated))

    @staticmethod
    def _origin(cfg: Connection, spec: SourceSpec, max_rows: int | None, truncated: bool) -> DatasetOrigin:
        return DatasetOrigin(
            connection_id=cfg.id,
            connection_name=cfg.name,
            kind=cfg.kind,
            table=spec.table,
            query=spec.query.strip() if spec.query and spec.query.strip() else None,
            url=spec.url.strip() if spec.url and spec.url.strip() else None,
            max_rows=max_rows,
            truncated=truncated,
            refreshed_at=datetime.now(UTC),
        )

    # --- SharePoint : connexion Microsoft -------------------------------------------------------

    def login_start(self, connection_id: str) -> DeviceCodeStart:
        cfg = self.get(connection_id)
        if cfg.kind != "sharepoint":
            raise ConnectorError("Connexion Microsoft réservée aux sources SharePoint.")
        with self._sharepoint_ready(cfg) as sp:
            start, pending = sp.start_login()
        self._pending[connection_id] = pending
        return start

    def login_poll(self, connection_id: str) -> AuthStatus:
        cfg = self.get(connection_id)
        pending = self._pending.get(connection_id)
        if pending is None:
            return (
                AuthStatus(status="signed_in", account=cfg.account)
                if cfg.signed_in
                else AuthStatus(status="expired", message="Aucune connexion en cours.")
            )
        with self._sharepoint_ready(cfg) as sp:
            status = sp.poll_login(pending)
        if status.status != "pending":
            self._pending.pop(connection_id, None)
        return status

    def logout(self, connection_id: str) -> Connection:
        self.get(connection_id)
        self.secrets.delete(self._key(connection_id, "msgraph"))
        self._pending.pop(connection_id, None)
        return self.get(connection_id)
