"""Actions d'écriture du nœud Atelier sur les rapports et les alertes (docs/SUITE.md §7.1).

- `reports.duplicate` : copie d'un rapport, rebranchée au besoin sur un autre jeu (un workflow crée le jeu
  du mois par `datasets.upsert_table`, puis duplique le rapport modèle dessus) ; signets personnels exclus.
- `alerts.create` / `alerts.set_enabled` / `alerts.evaluate` : par `AlertService`, mêmes règles que l'interface.

Erreurs au format du contrat (`AtelierError` : `NOT_FOUND`, `VALIDATION`, `CONFLICT`).
"""

import uuid
from datetime import UTC, datetime

from app.schemas.alert import Alert, AlertInput
from app.schemas.atelier import ReportDuplicateInput, ReportDuplicateResult
from app.schemas.report import Report
from app.services.alerts import AlertError, AlertService
from app.services.atelier.errors import AtelierError
from app.services.data.store import DatasetStore
from app.services.reports import ReportRepository

_CODES = {404: "NOT_FOUND", 409: "CONFLICT", 422: "VALIDATION"}


def _from_alert_error(exc: AlertError) -> AtelierError:
    return AtelierError(exc.status_code, _CODES.get(exc.status_code, "VALIDATION"), exc.message)


class AtelierWrites:
    """Écritures exposées au manifeste ; jamais d'accès direct aux fichiers des autres services."""

    def __init__(self, reports: ReportRepository, alerts: AlertService, store: DatasetStore) -> None:
        self.reports = reports
        self.alerts = alerts
        self.store = store

    # --- Rapports ----------------------------------------------------------------------------------

    def duplicate_report(self, body: ReportDuplicateInput) -> ReportDuplicateResult:
        source = self.reports.get(body.report_id)
        if source is None:
            raise AtelierError(404, "NOT_FOUND", f"Rapport « {body.report_id} » introuvable.")
        target = body.dataset_id
        profile = None
        if target is not None:
            profile = self.store.get(target)
            if profile is None:
                raise AtelierError(404, "NOT_FOUND", f"Jeu de données « {target} » introuvable.")
        now = datetime.now(UTC)
        copy = source.model_copy(deep=True)
        previous = source.dataset_id
        if previous is None:
            # Sans jeu par défaut : celui des visuels, s'ils en partagent un seul.
            ids = {v.dataset_id for p in source.pages for v in p.visuals if v.dataset_id}
            previous = next(iter(ids)) if len(ids) == 1 else None
        rebound = 0
        used: set[str] = set()
        for page in copy.pages:
            for visual in page.visuals:
                if target is not None and previous is not None and visual.dataset_id == previous:
                    visual.dataset_id = target
                    rebound += 1
                    used.update(b.field for bindings in visual.roles.values() for b in bindings if b.field)
        known: set[str] = set()
        if profile is not None:
            known = {c.name for c in profile.profile_data.columns} | {
                m.name for m in profile.profile_data.model.measures
            }
        report = Report(
            **copy.model_dump(exclude={"id", "name", "created_at", "updated_at", "bookmarks", "dataset_id"}),
            id=uuid.uuid4().hex[:12],
            name=body.name or f"{source.name} (copie)",
            dataset_id=target or source.dataset_id,
            bookmarks=[b for b in copy.bookmarks if not b.personal],
            created_at=now,
            updated_at=now,
        )
        self.reports.put(report, notify=True)
        return ReportDuplicateResult(
            report_id=report.id,
            name=report.name,
            rebound_visuals=rebound,
            missing_fields=sorted(used - known) if profile is not None else [],
        )

    # --- Alertes -----------------------------------------------------------------------------------

    def create_alert(self, body: AlertInput) -> Alert:
        try:
            return self.alerts.create(body)
        except AlertError as exc:
            raise _from_alert_error(exc) from exc

    def set_alert_enabled(self, alert_id: str, enabled: bool) -> Alert:
        try:
            current = self.alerts.get(alert_id)
            data = AlertInput.model_validate(
                current.model_dump(include=set(AlertInput.model_fields)) | {"enabled": enabled}
            )
            return self.alerts.update(alert_id, data)
        except AlertError as exc:
            raise _from_alert_error(exc) from exc

    async def evaluate_alert(self, alert_id: str) -> Alert:
        try:
            return await self.alerts.evaluate(alert_id, "manual")
        except AlertError as exc:
            raise _from_alert_error(exc) from exc
