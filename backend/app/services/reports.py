"""Rapports stockés en fichiers JSON lisibles (data/reports/<id>.json).

Le format fichier est volontaire : il se versionne tel quel dans Git (jalon GitHub).
"""

import builtins
import json
import logging
import re
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path

from app.schemas.report import Page, PageSize, Report, ReportBody, ReportCreate, ReportSummary

_ID_RE = re.compile(r"^[0-9a-f]{12}$")
logger = logging.getLogger(__name__)


class ReportRepository:
    """CRUD des rapports. Méthodes synchrones (accès disque) : appeler via `asyncio.to_thread`.

    Observateurs `on_saved` : appelés après `create` et `update` (enregistrement depuis l'interface ou l'API),
    pas après `put` (import depuis GitHub, restauration).
    """

    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self.directory.mkdir(parents=True, exist_ok=True)
        self._saved: list[Callable[[Report], None]] = []

    def on_saved(self, listener: Callable[[Report], None]) -> None:
        """Abonne un observateur appelé après la création ou l'enregistrement d'un rapport."""
        self._saved.append(listener)

    def _notify(self, report: Report) -> None:
        for listener in self._saved:
            try:
                listener(report)
            except Exception as exc:  # noqa: BLE001 — l'enregistrement est fait : l'observateur ne l'annule pas
                logger.warning("Observateur des rapports en échec : %s", exc)

    def _path(self, report_id: str) -> Path | None:
        return self.directory / f"{report_id}.json" if _ID_RE.match(report_id) else None

    def list(self) -> list[ReportSummary]:
        summaries = []
        for path in self.directory.glob("*.json"):
            try:
                report = Report.model_validate_json(path.read_text(encoding="utf-8"))
            except ValueError:
                continue  # fichier corrompu ou d'une autre version : ignoré
            summaries.append(
                ReportSummary(
                    id=report.id,
                    name=report.name,
                    pages=len(report.pages),
                    visuals=sum(len(p.visuals) for p in report.pages),
                    bookmarks=len(report.bookmarks),
                    updated_at=report.updated_at,
                )
            )
        return sorted(summaries, key=lambda s: s.updated_at, reverse=True)

    def get(self, report_id: str) -> Report | None:
        path = self._path(report_id)
        if path is None or not path.exists():
            return None
        return Report.model_validate_json(path.read_text(encoding="utf-8"))

    def create(self, payload: ReportCreate) -> Report:
        now = datetime.now(UTC)
        report = Report(
            id=uuid.uuid4().hex[:12],
            name=payload.name,
            dataset_id=payload.dataset_id,
            pages=[Page(id="p1", name="Page 1", size=PageSize())],
            created_at=now,
            updated_at=now,
        )
        self._write(report)
        self._notify(report)
        return report

    def update(self, report_id: str, body: ReportBody) -> Report | None:
        current = self.get(report_id)
        if current is None:
            return None
        report = Report(
            **body.model_dump(),
            id=current.id,
            created_at=current.created_at,
            updated_at=datetime.now(UTC),
        )
        self._write(report)
        self._notify(report)
        return report

    def put(self, report: Report) -> Report:
        """Écrit un rapport tel quel (identifiant et dates conservés) : import depuis GitHub."""
        if self._path(report.id) is None:
            raise ValueError(f"Identifiant de rapport invalide : « {report.id} ».")
        self._write(report)
        return report

    def all(self) -> "builtins.list[Report]":
        """Tous les rapports lisibles (les fichiers corrompus sont ignorés)."""
        out: builtins.list[Report] = []
        for path in sorted(self.directory.glob("*.json")):
            try:
                out.append(Report.model_validate_json(path.read_text(encoding="utf-8")))
            except ValueError:
                continue
        return out

    def delete(self, report_id: str) -> bool:
        path = self._path(report_id)
        if path is None or not path.exists():
            return False
        path.unlink()
        return True

    def _write(self, report: Report) -> None:
        path = self._path(report.id)
        assert path is not None
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(report.model_dump(mode="json"), ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)  # écriture atomique : pas de fichier à moitié écrit en cas de coupure
