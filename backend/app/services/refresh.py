"""Actualisation planifiée des jeux importés depuis une connexion.

- Planifications et journal dans `data/schedules.json` (à côté de `connections.json`, écriture atomique).
- Un ordonnanceur asyncio (`run_forever`, démarré dans le lifespan) appelle `tick` toutes les ~15 s ;
  l'horloge est injectable : les tests appellent `tick` sans attendre.
- Une seule exécution à la fois par jeu (verrou asyncio), manuelle ou planifiée.
- Politique réseau : SharePoint Online exige le mode « En ligne » ; hors ligne, l'exécution est
  sautée avec un statut explicite (de même qu'un serveur SQL public refusé hors ligne).
- Après chaque actualisation réussie, les observateurs (`on_refreshed`) sont prévenus (alertes).
- Arrêt propre (`shutdown`, appelé par le lifespan **avant** la fermeture de DuckDB) : les tâches lancées
  par `tick` sont gardées (référence forte) puis annulées ; le travail en cours dans un fil (`to_thread`
  ne peut pas être interrompu) est attendu jusqu'à un délai borné. Une actualisation qui ne s'est pas
  terminée à temps est journalisée « interrompue » ; une qui s'est terminée garde son vrai résultat.
"""

import asyncio
import json
import logging
import threading
import time
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta, tzinfo
from pathlib import Path

from pydantic import BaseModel, Field

from app.core.files import replace_file
from app.schemas.refresh import RefreshRun, RefreshSchedule, RunStatus, RunTrigger, ScheduleState
from app.services.connectors.base import ConnectorError, short
from app.services.data.model import ModelError
from app.services.data.store import DatasetStore, StoredDataset

logger = logging.getLogger(__name__)

MAX_RUNS = 20
INTERRUPTED = "Interrompue par l'arrêt de l'application : elle sera relancée à la prochaine échéance."
Clock = Callable[[], datetime]
Refresher = Callable[[StoredDataset], StoredDataset]
Listener = Callable[[str], Awaitable[None]]


def utc_now() -> datetime:
    """Horloge par défaut (UTC, avec fuseau)."""
    return datetime.now(UTC)


class _Entry(BaseModel):
    """Ce qui est enregistré pour un jeu."""

    schedule: RefreshSchedule = Field(default_factory=RefreshSchedule)
    since: datetime | None = Field(default=None, description="Date de la dernière modification de la planification.")
    last_at: datetime | None = Field(default=None, description="Dernier déclenchement planifié.")
    runs: list[RefreshRun] = Field(default_factory=list)


def _consume(future: "asyncio.Future[StoredDataset]") -> None:
    if not future.cancelled():
        future.exception()


class RefreshBusyError(ConnectorError):
    """Une actualisation du même jeu est déjà en cours."""

    def __init__(self) -> None:
        super().__init__("Une actualisation de ce jeu est déjà en cours : réessayez dans un instant.", 409)


def next_run(entry_schedule: RefreshSchedule, base: datetime, tz: tzinfo | None = None) -> datetime | None:
    """Prochaine exécution après `base` (UTC). `tz` : fuseau du mode quotidien (défaut : celui de la machine)."""
    if entry_schedule.mode == "off":
        return None
    if entry_schedule.mode == "interval":
        return base + timedelta(minutes=entry_schedule.minutes)
    hour, minute = (int(x) for x in entry_schedule.at.split(":"))
    local = base.astimezone(tz) if tz else base.astimezone()
    day = local.date()
    for _ in range(3):
        naive = datetime(day.year, day.month, day.day, hour, minute)
        # Sans fuseau imposé : heure locale de la machine, changements d'heure compris.
        candidate = naive.replace(tzinfo=tz) if tz else naive.astimezone()
        if candidate > base:
            return candidate.astimezone(UTC)
        day += timedelta(days=1)
    return None  # pragma: no cover — impossible : trois jours couvrent tous les cas


class RefreshScheduler:
    """Planifications, exécutions et journal des actualisations."""

    def __init__(
        self,
        path: Path,
        store: DatasetStore,
        refresher: Refresher,
        is_online: Callable[[], bool],
        clock: Clock = utc_now,
        tz: tzinfo | None = None,
    ) -> None:
        self.path = path
        self.store = store
        self.refresher = refresher
        self.is_online = is_online
        self.clock = clock
        self.tz = tz
        self._file_lock = threading.Lock()
        self._locks: dict[str, asyncio.Lock] = {}
        self._running: set[str] = set()
        self._listeners: list[Listener] = []
        self._tasks: set[asyncio.Task[RefreshRun]] = set()  # tâches de `tick` (référence forte)
        self._work: set[asyncio.Future[StoredDataset]] = set()  # actualisations en cours dans un fil
        self._stopping = False
        self._deadline: float | None = None  # échéance de l'arrêt (horloge de la boucle)
        self.shutdown_grace = 10.0  # attente du fil si la tâche est annulée hors `shutdown`

    # --- Persistance ----------------------------------------------------------------------------

    def _read(self) -> dict[str, _Entry]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return {}
        out: dict[str, _Entry] = {}
        for key, value in (raw.get("datasets", {}) if isinstance(raw, dict) else {}).items():
            try:
                out[str(key)] = _Entry.model_validate(value)
            except ValueError:
                continue  # entrée illisible : ignorée
        return out

    def _write(self, entries: dict[str, _Entry]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        payload = {"version": 1, "datasets": {k: v.model_dump(mode="json") for k, v in entries.items()}}
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        replace_file(tmp, self.path)

    def _update(self, dataset_id: str, fn: Callable[[_Entry], None]) -> _Entry:
        with self._file_lock:
            entries = self._read()
            entry = entries.get(dataset_id) or _Entry()
            fn(entry)
            entries[dataset_id] = entry
            self._write(entries)
            return entry

    def forget(self, dataset_id: str) -> None:
        """Oublie la planification et le journal d'un jeu (jeu supprimé)."""
        with self._file_lock:
            entries = self._read()
            if entries.pop(dataset_id, None) is not None:
                self._write(entries)

    # --- Lecture -------------------------------------------------------------------------------

    def _next(self, entry: _Entry) -> datetime | None:
        base = entry.last_at or entry.since or self.clock()
        return next_run(entry.schedule, base, self.tz)

    def _state(self, dataset: StoredDataset, entry: _Entry) -> ScheduleState:
        origin = dataset.profile_data.origin
        assert origin is not None
        return ScheduleState(
            dataset_id=dataset.id,
            dataset_name=dataset.name,
            connection_name=origin.connection_name,
            kind=origin.kind,
            schedule=entry.schedule,
            next_run=self._next(entry),
            running=dataset.id in self._running,
            needs_online=origin.kind == "sharepoint",
            refreshed_at=origin.refreshed_at,
            runs=list(reversed(entry.runs)),
        )

    def _refreshable(self, dataset_id: str) -> StoredDataset:
        dataset = self.store.get(dataset_id)
        if dataset is None:
            raise ConnectorError(f"Jeu de données « {dataset_id} » introuvable.", 404)
        if dataset.profile_data.origin is None:
            raise ConnectorError(
                "Seul un jeu importé depuis une connexion peut être actualisé : "
                "réimportez ce fichier pour le mettre à jour."
            )
        return dataset

    def get(self, dataset_id: str) -> ScheduleState:
        """État d'un jeu actualisable (planification désactivée par défaut). Synchrone : via `to_thread`."""
        dataset = self._refreshable(dataset_id)
        return self._state(dataset, self._read().get(dataset_id) or _Entry())

    def states(self) -> list[ScheduleState]:
        """Tous les jeux actualisables, planifiés d'abord. Synchrone : via `to_thread`."""
        entries = self._read()
        found = [d for d in self.store.list() if d.profile_data.origin is not None]
        states = [self._state(d, entries.get(d.id) or _Entry()) for d in found]
        return sorted(states, key=lambda s: (s.schedule.mode == "off", s.dataset_name.lower()))

    def versions(self) -> dict[str, str]:
        """Horodatage de version de chaque jeu actualisable : le front recharge les visuels quand il change."""
        return {
            d.id: d.profile_data.origin.refreshed_at.isoformat()
            for d in self.store.list()
            if d.profile_data.origin is not None
        }

    def set_schedule(self, dataset_id: str, schedule: RefreshSchedule) -> ScheduleState:
        """Enregistre la planification ; le décompte repart de maintenant. Synchrone : via `to_thread`."""
        dataset = self._refreshable(dataset_id)
        now = self.clock()

        def apply(entry: _Entry) -> None:
            entry.schedule = schedule
            entry.since = now
            entry.last_at = None

        return self._state(dataset, self._update(dataset_id, apply))

    # --- Exécution -------------------------------------------------------------------------------

    def on_refreshed(self, listener: Listener) -> None:
        """Abonne un observateur appelé après chaque actualisation réussie (identifiant du jeu)."""
        self._listeners.append(listener)

    def is_running(self, dataset_id: str) -> bool:
        return dataset_id in self._running

    async def run(self, dataset_id: str, trigger: RunTrigger, raise_errors: bool = False) -> RefreshRun:
        """Actualise un jeu (une exécution à la fois) et l'inscrit au journal.

        `raise_errors` (actualisation manuelle depuis l'API) : l'erreur est journalisée puis relancée,
        pour garder les codes HTTP (403 hors ligne, 409 modèle incompatible…).
        """
        try:
            dataset = await asyncio.to_thread(self._refreshable, dataset_id)
        except ConnectorError as exc:
            if raise_errors:
                raise
            return RefreshRun(
                started_at=self.clock(), duration_ms=0, status="error", trigger=trigger, message=exc.message
            )
        lock = self._locks.setdefault(dataset_id, asyncio.Lock())
        if lock.locked():
            if raise_errors:
                raise RefreshBusyError()
            return RefreshRun(
                started_at=self.clock(), duration_ms=0, status="skipped", trigger=trigger, message="Déjà en cours."
            )
        async with lock:
            self._running.add(dataset_id)
            started, t0 = self.clock(), time.perf_counter()
            status: RunStatus = "success"
            rows: int | None = None
            message: str | None = None
            error: Exception | None = None
            cancelled = False
            try:
                origin = dataset.profile_data.origin
                if origin is not None and origin.kind == "sharepoint" and not self.is_online():
                    status = "skipped"
                    message = "Mode hors ligne : SharePoint Online exige le mode « En ligne ». Exécution sautée."
                    error = ConnectorError(message, 403)
                else:
                    work = self._start(dataset)
                    try:
                        updated: StoredDataset | None = await asyncio.shield(work)
                    except asyncio.CancelledError:
                        # Arrêt de l'application : le fil ne peut pas être interrompu, on l'attend (borné).
                        cancelled = True
                        updated = await self._settle(work)
                    if updated is None:
                        status, message = "interrupted", INTERRUPTED
                    else:
                        rows = updated.profile_data.rows
                        if cancelled:
                            message = "Terminée pendant l'arrêt de l'application."
            except ConnectorError as exc:
                # 403 = refus de la politique réseau (hors ligne) : sauté, pas en échec.
                status, message, error = ("skipped" if exc.status_code == 403 else "error"), exc.message, exc
            except ModelError as exc:
                status, error = "error", exc
                details = "; ".join(f"{i.name} : {i.error}" for i in exc.issues[:3])
                message = f"Les nouvelles données ne correspondent plus au modèle (rien n'a changé). {details}".strip()
            except Exception as exc:  # noqa: BLE001 — journalisé, l'ordonnanceur continue
                status, message, error = "error", short(exc), exc
                logger.warning("Actualisation de %s en échec : %s", dataset_id, message)
            finally:
                self._running.discard(dataset_id)
            run = RefreshRun(
                started_at=started,
                duration_ms=int((time.perf_counter() - t0) * 1000),
                status=status,
                trigger=trigger,
                rows=rows,
                message=message,
            )
            if cancelled:
                self._log(dataset_id, run)  # écriture directe : la tâche est en cours d'annulation
                if status == "interrupted":
                    logger.warning("Actualisation de %s interrompue par l'arrêt de l'application.", dataset_id)
                raise asyncio.CancelledError
            await asyncio.to_thread(self._log, dataset_id, run)
        if status == "success":
            for listener in self._listeners:
                try:
                    await listener(dataset_id)
                except Exception as exc:  # noqa: BLE001 — un observateur en échec ne bloque pas les autres
                    logger.warning("Observateur d'actualisation en échec : %s", short(exc))
        if raise_errors and error is not None:
            raise error
        return run

    def _start(self, dataset: StoredDataset) -> "asyncio.Future[StoredDataset]":
        """Lance l'actualisation dans un fil ; le garde jusqu'à sa fin (l'arrêt l'attend avant de fermer DuckDB)."""
        work = asyncio.ensure_future(asyncio.to_thread(self.refresher, dataset))
        self._work.add(work)
        work.add_done_callback(self._work.discard)
        work.add_done_callback(_consume)  # fil fini après l'échéance de l'arrêt : erreur lue, pas d'avertissement
        return work

    async def _settle(self, work: "asyncio.Future[StoredDataset]") -> StoredDataset | None:
        """Attend la fin du fil jusqu'à l'échéance de l'arrêt ; None s'il tourne encore (interrompue)."""
        loop = asyncio.get_running_loop()
        timeout = self.shutdown_grace if self._deadline is None else max(0.0, self._deadline - loop.time())
        done, _ = await asyncio.wait({work}, timeout=timeout)
        return work.result() if done else None  # une erreur du fil est relevée et journalisée comme telle

    def _log(self, dataset_id: str, run: RefreshRun) -> None:
        def apply(entry: _Entry) -> None:
            entry.runs = [*entry.runs, run][-MAX_RUNS:]

        self._update(dataset_id, apply)

    async def tick(self) -> list[asyncio.Task[RefreshRun]]:
        """Lance les actualisations arrivées à échéance ; retourne les tâches lancées (les tests les attendent)."""
        if self._stopping:
            return []
        now = self.clock()
        entries = await asyncio.to_thread(self._read)
        tasks: list[asyncio.Task[RefreshRun]] = []
        for dataset_id, entry in entries.items():
            if entry.schedule.mode == "off" or dataset_id in self._running:
                continue
            due = self._next(entry)
            if due is None or due > now:
                continue
            exists = await asyncio.to_thread(self.store.get, dataset_id)
            if exists is None:
                await asyncio.to_thread(self.forget, dataset_id)
                continue

            def mark(e: _Entry, at: datetime = now) -> None:
                e.last_at = at

            # Prochaine échéance comptée depuis ce déclenchement (une exécution manquée est rattrapée une fois).
            await asyncio.to_thread(self._update, dataset_id, mark)
            task = asyncio.create_task(self.run(dataset_id, "schedule"))
            self._tasks.add(task)  # la boucle ne garde qu'une référence faible : on la retient ici
            task.add_done_callback(self._tasks.discard)
            tasks.append(task)
        return tasks

    def in_flight(self) -> int:
        """Nombre de tâches planifiées et d'actualisations (fils) encore en cours."""
        return len(self._tasks) + sum(1 for w in self._work if not w.done())

    async def shutdown(self, timeout: float = 10.0) -> int:
        """Arrêt propre, à appeler avant de fermer DuckDB.

        Plus aucun lancement ; les tâches planifiées sont annulées (chacune journalise son issue) et les
        actualisations en cours dans un fil (manuelles comprises) sont attendues au plus `timeout` secondes.
        Retourne le nombre de fils encore actifs à l'échéance (0 = tout est terminé).
        """
        self._stopping = True
        loop = asyncio.get_running_loop()
        self._deadline = loop.time() + timeout
        tasks = list(self._tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.wait(tasks, timeout=timeout + 1.0)  # chaque tâche s'arrête au plus à l'échéance
        pending = [w for w in self._work if not w.done()]
        if pending:
            await asyncio.wait(pending, timeout=max(0.0, self._deadline - loop.time()))
        left = sum(1 for w in self._work if not w.done())
        if left:
            logger.warning("Arrêt : %d actualisation(s) encore en cours après %.0f s.", left, timeout)
        return left

    async def run_forever(self, period_seconds: float = 15.0) -> None:
        """Boucle de l'ordonnanceur (tâche du lifespan, annulée à l'arrêt).

        Une échéance passée pendant que l'application était fermée est rattrapée une fois, au premier passage.
        """
        while True:
            await asyncio.sleep(period_seconds)
            try:
                await self.tick()
            except Exception as exc:  # noqa: BLE001 — l'ordonnanceur ne doit jamais s'arrêter
                logger.warning("Ordonnanceur : %s", short(exc))
