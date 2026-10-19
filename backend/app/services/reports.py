"""Rapports stockés en fichiers JSON lisibles (data/reports/<id>.json).

Le format fichier est volontaire : il se versionne tel quel dans Git (jalon GitHub).
"""

import json
import re
import uuid
from datetime import UTC, datetime
from pathlib import Path

from app.schemas.report import Page, PageSize, Report, ReportBody, ReportCreate, ReportSummary

_ID_RE = re.compile(r"^[0-9a-f]{12}$")


class ReportRepository:
    """CRUD des rapports. Méthodes synchrones (accès disque) : appeler via `asyncio.to_thread`."""

    def __init__(self, directory: Path) -> None:
        self.directory = directory
        self.directory.mkdir(parents=True, exist_ok=True)

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
        return report

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
