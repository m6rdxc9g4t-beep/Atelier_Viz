"""Actions du nœud Atelier qui touchent aux jeux de données : lecture en table d'échange, requête, upsert.

Méthodes synchrones (DuckDB, pandas) : via `asyncio.to_thread`.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime

from app.schemas.atelier import AtelierTable, UpsertTableInput, UpsertTableResult
from app.schemas.connection import AtelierTableOrigin
from app.schemas.query import QueryRequest
from app.services.atelier.errors import AtelierError
from app.services.atelier.events import AtelierEvents
from app.services.atelier.tables import TableError, dataset_table, query_table, snake_key, table_frame
from app.services.data.model import ModelError
from app.services.data.store import DatasetStore, StoredDataset
from app.services.engine.database import LocalDatabase
from app.services.engine.query import QueryError, run_query

logger = logging.getLogger(__name__)

ReplacedListener = Callable[[str], Awaitable[object]]


class AtelierService:
    """Jeux de données vus par un workflow (Atelier Nexus)."""

    def __init__(self, store: DatasetStore, db: LocalDatabase, events: AtelierEvents) -> None:
        self.store = store
        self.db = db
        self.events = events
        self._upsert_lock = threading.Lock()  # recherche par clé + création : jamais deux jeux pour une clé
        self._replaced: list[ReplacedListener] = []

    def on_replaced(self, listener: ReplacedListener) -> None:
        """Abonne un observateur appelé après le remplacement des données d'un jeu par un workflow (identifiant).

        Pendant de `RefreshScheduler.on_refreshed` pour les jeux `atelier-table` (alertes à réévaluer).
        """
        self._replaced.append(listener)

    async def notify_replaced(self, dataset_id: str) -> None:
        """Prévient les observateurs ; une erreur est journalisée, jamais relancée (la table est déjà enregistrée)."""
        for listener in self._replaced:
            try:
                await listener(dataset_id)
            except Exception as exc:  # noqa: BLE001 — un observateur en échec ne fait pas échouer l'upsert
                logger.warning("Observateur de remplacement en échec pour %s : %s", dataset_id, exc)

    def dataset(self, dataset_id: str) -> StoredDataset:
        dataset = self.store.get(dataset_id)
        if dataset is None:
            raise AtelierError(404, "NOT_FOUND", f"Jeu de données « {dataset_id} » introuvable.")
        return dataset

    def table(self, dataset_id: str, offset: int, limit: int) -> AtelierTable:
        """Page de lignes d'un jeu au format `atelier-table/1`."""
        return dataset_table(self.db, self.dataset(dataset_id), offset, limit)

    def query(self, req: QueryRequest) -> AtelierTable:
        """Requête du moteur des visuels (jamais de SQL du client), résultat en `atelier-table/1`."""
        dataset = self.dataset(req.dataset_id)
        try:
            res = run_query(self.db, dataset.source, dataset.profile(), req)
        except QueryError as exc:
            raise AtelierError(422, "VALIDATION", str(exc)) from exc
        return query_table(req, res, snake_key(dataset.name, "jeu"), dataset.name)

    def upsert(self, body: UpsertTableInput) -> UpsertTableResult:
        """Crée le jeu de la clé `body.key`, ou remplace ses données (`DatasetStore.replace_data`, modèle revalidé)."""
        try:
            df = table_frame(body.table)
        except TableError as exc:
            raise AtelierError(422, "VALIDATION", str(exc)) from exc
        origin = AtelierTableOrigin(key=body.key, table_name=body.table.name, refreshed_at=datetime.now(UTC))
        with self._upsert_lock:
            existing = self.store.find_by_origin_key(body.key)
            if existing is None:
                created = self.store.add(body.name, "atelier_table", df, origin)  # événement : on_created
                return UpsertTableResult(
                    dataset_id=created.id, name=created.name, rows=created.profile_data.rows, action="created"
                )
            try:
                updated = self.store.replace_data(existing, df, origin)
            except ModelError as exc:
                raise AtelierError(
                    409,
                    "CONFLICT",
                    "La nouvelle table ne correspond plus au modèle du jeu (colonne disparue ?) : rien n'a changé.",
                    {"issues": [i.model_dump() for i in exc.issues]},
                ) from exc
        self.events.dataset_replaced(updated)
        return UpsertTableResult(
            dataset_id=updated.id, name=updated.name, rows=updated.profile_data.rows, action="updated"
        )
