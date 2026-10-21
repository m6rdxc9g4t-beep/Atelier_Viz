"""Émission des événements d'Atelier Viz (docs/SUITE.md §7.3) à partir des observateurs des services.

Un seul point de branchement (`AtelierEvents.attach`, appelé par le lifespan) :

| Événement | Source |
|---|---|
| `viz.dataset.created` | `DatasetStore.on_created` (fichier, connexion, exemples, `datasets.upsert_table`) |
| `viz.dataset.refreshed` | `RefreshScheduler.on_run` (succès), ou `datasets.upsert_table` sur un jeu existant |
| `viz.dataset.refresh_failed` | `RefreshScheduler.on_run` (échec, exécution sautée ou interrompue) |
| `viz.dataset.deleted` | `DatasetStore.on_removed` |
| `viz.alert.triggered` | `AlertService.on_fired` (au franchissement, là où partent notifications et webhook) |
| `viz.report.saved` | `ReportRepository.on_saved` (création et enregistrement), regroupé par rapport |

`data` ne contient jamais de ligne de données ni de secret (ni URL de webhook, ni requête SQL d'une connexion).

Regroupement des rapports : le Studio enregistre automatiquement (≈ toutes les 800 ms pendant l'édition) ;
un événement par enregistrement épuiserait la rétention du journal. Les enregistrements d'un même rapport
rapprochés de moins de `report_delay` secondes donnent **un** événement, émis à la fin de la rafale
(0 = immédiat). `flush` (arrêt de l'application) émet ceux qui attendent.
"""

from __future__ import annotations

import asyncio
import threading
from typing import TYPE_CHECKING

from app.schemas.alert import Alert, AlertGroupEvent
from app.schemas.atelier import (
    AlertTriggeredData,
    AlertValue,
    DatasetCreatedData,
    DatasetDeletedData,
    DatasetRefreshedData,
    DatasetRefreshFailedData,
    ReportSavedData,
)
from app.schemas.connection import AtelierTableOrigin, DatasetOrigin
from app.schemas.refresh import RefreshRun
from app.schemas.report import Report
from app.services.atelier.journal import EventJournal
from app.services.data.store import DatasetStore, StoredDataset

if TYPE_CHECKING:
    from app.services.alerts import AlertService
    from app.services.refresh import RefreshScheduler
    from app.services.reports import ReportRepository

MAX_ALERT_VALUES = 50


def origin_label(dataset: StoredDataset) -> str:
    """Provenance d'un jeu, sans détail sensible : `file`, type de connexion, ou `atelier-table`."""
    origin = dataset.profile_data.origin
    if isinstance(origin, AtelierTableOrigin):
        return "atelier-table"
    if isinstance(origin, DatasetOrigin):
        return origin.kind
    return "file"


class AtelierEvents:
    """Traduit les changements des services en événements du journal."""

    def __init__(self, journal: EventJournal, store: DatasetStore, report_delay: float = 5.0) -> None:
        self.journal = journal
        self.store = store
        self.report_delay = report_delay
        self._pending: dict[str, tuple[threading.Timer, Report]] = {}
        self._lock = threading.Lock()

    def attach(
        self,
        scheduler: RefreshScheduler,
        alerts: AlertService,
        reports: ReportRepository,
    ) -> None:
        """Abonne le journal à tous les services qui produisent des événements."""
        self.store.on_created(self.dataset_created)
        self.store.on_removed(self.dataset_deleted)
        scheduler.on_run(self.refresh_run)
        alerts.on_fired(self.alert_fired)
        reports.on_saved(self.report_saved)

    # --- Jeux de données ------------------------------------------------------------------------

    def dataset_created(self, dataset: StoredDataset) -> None:
        origin = dataset.profile_data.origin
        data = DatasetCreatedData(
            name=dataset.name,
            rows=dataset.profile_data.rows,
            origin=origin_label(dataset),
            format=dataset.profile_data.format,
            key=origin.key if isinstance(origin, AtelierTableOrigin) else None,
        )
        self.journal.emit("viz.dataset.created", dataset.id, dataset.name, data)

    def dataset_deleted(self, dataset_id: str, name: str) -> None:
        self.journal.emit("viz.dataset.deleted", dataset_id, name, DatasetDeletedData())

    def dataset_replaced(self, dataset: StoredDataset) -> None:
        """Données d'un jeu remplacées par un workflow (`datasets.upsert_table`)."""
        data = DatasetRefreshedData(rows=dataset.profile_data.rows, trigger="manual", source="atelier-table")
        self.journal.emit("viz.dataset.refreshed", dataset.id, dataset.name, data)

    async def refresh_run(self, dataset_id: str, run: RefreshRun) -> None:
        """Fin d'une exécution de l'ordonnanceur (manuelle ou planifiée), réussie ou non."""
        dataset = await asyncio.to_thread(self.store.get, dataset_id)
        label = dataset.name if dataset else None
        if run.status == "success":
            rows = run.rows if run.rows is not None else (dataset.profile_data.rows if dataset else 0)
            payload = DatasetRefreshedData(rows=rows, trigger=run.trigger)
            await asyncio.to_thread(self.journal.emit, "viz.dataset.refreshed", dataset_id, label, payload)
            return
        failed = DatasetRefreshFailedData(
            trigger=run.trigger, status=run.status, message=run.message or "Actualisation en échec."
        )
        await asyncio.to_thread(self.journal.emit, "viz.dataset.refresh_failed", dataset_id, label, failed)

    # --- Alertes --------------------------------------------------------------------------------

    async def alert_fired(self, alert: Alert, fired: list[AlertGroupEvent]) -> None:
        first = fired[0]
        data = AlertTriggeredData(
            dataset_id=alert.dataset_id,
            value=first.value,
            comparison=alert.comparison,
            threshold=alert.threshold,
            basis=alert.basis,
        )
        if alert.split_by:
            data.dimension = alert.split_by
            data.values = [AlertValue(key=g.key, value=g.value) for g in fired[:MAX_ALERT_VALUES]]
        await asyncio.to_thread(self.journal.emit, "viz.alert.triggered", alert.id, alert.name, data)

    # --- Rapports -------------------------------------------------------------------------------

    def report_saved(self, report: Report) -> None:
        if self.report_delay <= 0:
            self._emit_report(report)
            return
        with self._lock:
            previous = self._pending.pop(report.id, None)
            if previous is not None:
                previous[0].cancel()
            timer = threading.Timer(self.report_delay, self._fire_report, args=(report.id,))
            timer.daemon = True
            self._pending[report.id] = (timer, report)
            timer.start()

    def _fire_report(self, report_id: str) -> None:
        with self._lock:
            entry = self._pending.pop(report_id, None)
        if entry is not None:
            self._emit_report(entry[1])

    def _emit_report(self, report: Report) -> None:
        self.journal.emit("viz.report.saved", report.id, report.name, ReportSavedData(pages=len(report.pages)))

    def flush(self) -> None:
        """Émet tout de suite les enregistrements de rapport en attente (arrêt de l'application)."""
        with self._lock:
            pending = list(self._pending.values())
            self._pending.clear()
        for timer, report in pending:
            timer.cancel()
            self._emit_report(report)
