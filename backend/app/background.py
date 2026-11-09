"""Actualisation planifiée **quand l'application est fermée** (tâche du système, sans fenêtre ni serveur).

Lancée périodiquement par launchd (macOS), le Planificateur de tâches (Windows) ou un minuteur systemd
(Linux) — voir `services/background_job.py` — via `backend/refresh_once.py` :

1. ouvre la base DuckDB ; si l'application est ouverte, la base est verrouillée : on s'arrête aussitôt
   (l'application actualise elle-même), statut « application ouverte » ;
2. construit les mêmes services que l'application (préférences, connexions, ordonnanceur, alertes avec
   notifications système et e-mail, journal du nœud Atelier) ;
3. lance les actualisations arrivées à échéance (`RefreshScheduler.tick`, rattrapage une fois), attend leur
   fin (alertes évaluées par les mêmes observateurs), puis ferme tout proprement ;
4. écrit le bilan dans `data/background.json` (affiché dans Automatisation).

Même politique réseau que l'application (mode hors ligne respecté), aucune donnée ailleurs que `data/`.
"""

import asyncio
import json
import logging
import os
from datetime import UTC, datetime
from pathlib import Path

import duckdb
from pydantic import BaseModel, Field

from app.core.config import Settings, get_settings

logger = logging.getLogger(__name__)
STATUS_FILE = "background.json"


class BackgroundStatus(BaseModel):
    """Dernier passage de la tâche du système."""

    last_run_at: datetime | None = None
    status: str = Field(default="never", description="never · done · app_open · error")
    refreshed: int = 0
    failed: int = 0
    skipped: int = 0
    message: str | None = None


def status_path(settings: Settings) -> Path:
    return Path(settings.data_dir) / STATUS_FILE


def read_status(settings: Settings) -> BackgroundStatus:
    try:
        return BackgroundStatus.model_validate_json(status_path(settings).read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        return BackgroundStatus()


def _write_status(settings: Settings, status: BackgroundStatus) -> None:
    path = status_path(settings)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(status.model_dump(mode="json"), ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


async def refresh_due(settings: Settings, now: datetime | None = None) -> BackgroundStatus:
    """Un passage : actualise les jeux arrivés à échéance et évalue leurs alertes, puis ferme tout."""
    # Imports tardifs : `python -m app.background --help` reste rapide, et les tests injectent leur Settings.
    from app.services.alerts import AlertService
    from app.services.atelier.events import AtelierEvents
    from app.services.atelier.journal import EventJournal
    from app.services.connectors import ConnectionService, build_secrets
    from app.services.data.store import DatasetStore
    from app.services.email import EmailService
    from app.services.engine.database import LocalDatabase
    from app.services.preferences import PreferencesStore
    from app.services.refresh import RefreshScheduler
    from app.services.reports import ReportRepository
    from app.services.system_notify import system_notifier

    at = now or datetime.now(UTC)
    data_dir = Path(settings.data_dir)
    try:
        database = LocalDatabase(data_dir / "atelier.duckdb")
    except duckdb.IOException:
        status = BackgroundStatus(
            last_run_at=at, status="app_open", message="Application ouverte : elle actualise elle-même."
        )
        _write_status(settings, status)
        return status

    preferences = PreferencesStore(data_dir / "settings.json")
    online = lambda: preferences.get().online_mode  # noqa: E731
    store = DatasetStore(database)
    secrets = build_secrets(settings.secrets_backend, data_dir / "secrets.json")
    connections = ConnectionService(data_dir / "connections.json", secrets, settings, store, is_online=online)
    scheduler = RefreshScheduler(
        data_dir / "schedules.json", store, connections.refresh, is_online=online, clock=lambda: at
    )
    email = EmailService(data_dir / "email.json", secrets, is_online=online)
    alerts = AlertService(
        data_dir / "alerts.json",
        store,
        database,
        is_online=online,
        notifier=system_notifier() if settings.system_notifications else None,
        email=email,
    )
    events = AtelierEvents(EventJournal(data_dir / "atelier_events.jsonl"), store, report_delay=0)
    events.attach(scheduler, alerts, ReportRepository(data_dir / "reports"))
    scheduler.on_refreshed(alerts.evaluate_dataset)
    try:
        tasks = await scheduler.tick()
        runs = await asyncio.gather(*tasks, return_exceptions=True)
        ok = [r for r in runs if not isinstance(r, BaseException) and r.status == "success"]
        skipped = [r for r in runs if not isinstance(r, BaseException) and r.status == "skipped"]
        status = BackgroundStatus(
            last_run_at=at,
            status="done",
            refreshed=len(ok),
            skipped=len(skipped),
            failed=len(runs) - len(ok) - len(skipped),
            message=None if runs else "Aucune actualisation à échéance.",
        )
    except Exception as exc:  # noqa: BLE001 — le bilan doit toujours être écrit
        logger.exception("Actualisation en arrière-plan en échec")
        status = BackgroundStatus(last_run_at=at, status="error", message=f"{type(exc).__name__} : {exc}"[:300])
    finally:
        await scheduler.shutdown(30.0)
        events.flush()
        database.close()
    _write_status(settings, status)
    return status


def main() -> int:
    """Point d'entrée de la tâche du système : code 0 sauf erreur inattendue."""
    logging.basicConfig(level=logging.WARNING)
    status = asyncio.run(refresh_due(get_settings()))
    return 1 if status.status == "error" else 0


if __name__ == "__main__":
    raise SystemExit(main())
