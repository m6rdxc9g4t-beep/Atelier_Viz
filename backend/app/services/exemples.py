"""Exemples de la suite (`exemples-suite/`, format `atelier-exemples/1`).

Le dossier est généré par Atelier_Deploy (`exemples/generer.py`) et copié tel quel dans chaque app : une histoire
fictive par fichier `<histoire>.json`. Pour Viz, chaque histoire apporte ses jeux de données (tables
`atelier-table/1` : les opérations des relevés catégorisées, les tables de Tab, les exports convertis par Convert) et
une alerte qui se déclenche en octobre : l'événement `viz.alert.triggered` qu'un workflow Nexus transforme en tâche
dans Projets.

Charger passe par les mêmes chemins qu'un workflow : `AtelierService.upsert` (clé `exemple:<histoire>:<table>`, un
rechargement remplace les données sans dupliquer) et `AlertService` (créée puis évaluée, comme la route). Retirer
supprime les jeux de ces clés, leurs alertes et le rapport d'exemple de l'histoire ; rien d'autre.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from pydantic import BaseModel

from app.schemas.alert import AlertInput
from app.schemas.atelier import UpsertTableInput
from app.schemas.dataset import DatasetSummary
from app.services.alerts import AlertService
from app.services.atelier.service import AtelierService
from app.services.data import DatasetStore
from app.services.reports import ReportRepository

FORMAT = "atelier-exemples/1"
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
REPORT_PREFIX = "Exemple — "


class ExempleEtape(BaseModel):
    app: str
    titre: str
    texte: str


class ExempleHistoire(BaseModel):
    """Histoire telle que l'affiche le panneau « Exemples de la suite »."""

    id: str
    titre: str
    sous_titre: str
    secteur: str
    resume: str
    parcours: list[ExempleEtape]
    jeux: list[str]
    alerte: str
    rapport: str
    charge: bool


class ExempleCharge(BaseModel):
    """Résultat du chargement : jeux créés ou mis à jour, alerte, jeu à ouvrir dans un rapport."""

    histoire: str
    datasets: list[DatasetSummary]
    operations_id: str
    alerte_id: str
    alerte_declenchee: bool
    rapport: str


class ExempleError(Exception):
    def __init__(self, message: str, status_code: int = 404) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def _key_prefix(histoire: str) -> str:
    return f"exemple:{histoire}:"


class ExemplesSuite:
    """Histoires d'exemple livrées avec l'app, chargées dans les jeux de données et les alertes."""

    def __init__(
        self,
        directory: Path,
        store: DatasetStore,
        atelier: AtelierService,
        alerts: AlertService,
        reports: ReportRepository,
    ) -> None:
        self.directory = directory
        self.store = store
        self.atelier = atelier
        self.alerts = alerts
        self.reports = reports

    # ─── Lecture ────────────────────────────────────────────────────────────────────────────────

    def _json(self, path: Path) -> dict[str, Any] | None:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
        return data if isinstance(data, dict) and data.get("format") == FORMAT else None

    def _part(self, histoire: str) -> dict[str, Any]:
        part = self._json(self.directory / f"{histoire}.json") if ID_RE.match(histoire) else None
        if part is None or not part.get("jeux"):
            raise ExempleError("Exemple introuvable.")
        return part

    def _datasets(self, histoire: str) -> list[Any]:
        prefix = _key_prefix(histoire)
        out = []
        for d in self.store.list():
            origin = d.profile_data.origin
            if origin is not None and origin.kind == "atelier-table" and (origin.key or "").startswith(prefix):
                out.append(d)
        return out

    def histoires(self) -> list[ExempleHistoire]:
        index = self._json(self.directory / "index.json")
        if index is None:
            return []
        loaded = {
            k.split(":")[1]
            for d in self.store.list()
            if (o := d.profile_data.origin) is not None
            and o.kind == "atelier-table"
            and (k := o.key or "").startswith("exemple:")
            and k.count(":") >= 2
        }
        out = []
        for h in index.get("histoires", []):
            try:
                part = self._part(str(h.get("id", "")))
            except ExempleError:
                continue
            out.append(
                ExempleHistoire(
                    id=h["id"],
                    titre=h["titre"],
                    sous_titre=h.get("sous_titre", ""),
                    secteur=h.get("secteur", ""),
                    resume=h.get("resume", ""),
                    parcours=[ExempleEtape(**e) for e in h.get("parcours", [])],
                    jeux=[j["nom"] for j in part["jeux"]],
                    alerte=part["alerte"]["nom"],
                    rapport=REPORT_PREFIX + h["titre"],
                    charge=h["id"] in loaded,
                )
            )
        return out

    # ─── Chargement ─────────────────────────────────────────────────────────────────────────────

    def upsert(self, histoire: str) -> tuple[list[DatasetSummary], str, AlertInput, str]:
        """Crée ou met à jour les jeux de l'histoire.

        Renvoie (jeux, id du jeu des opérations, alerte à créer, nom du rapport).
        """
        part = self._part(histoire)
        summaries: list[DatasetSummary] = []
        ids: dict[str, str] = {}
        for jeu in part["jeux"]:
            result = self.atelier.upsert(UpsertTableInput(name=jeu["nom"], key=jeu["cle"], table=jeu["table"]))
            ids[jeu["cle"]] = result.dataset_id
            stored = self.store.get(result.dataset_id)
            if stored is not None:
                summaries.append(stored.summary())
        a = part["alerte"]
        operations_id = ids[a["jeu_cle"]]
        alert = AlertInput(
            name=a["nom"],
            dataset_id=operations_id,
            measure=a["mesure"],
            filters=a["filtres"],
            comparison=a["comparaison"],
            threshold=a["seuil"],
            notify=True,
            system=False,
        )
        return summaries, operations_id, alert, REPORT_PREFIX + part["histoire"]["titre"]

    def existing_alert(self, name: str, dataset_id: str) -> str | None:
        """Alerte de l'exemple déjà créée sur ce jeu (un rechargement ne la duplique pas)."""
        return next((a.id for a in self.alerts.list_alerts(dataset_id) if a.name == name), None)

    # ─── Retrait ────────────────────────────────────────────────────────────────────────────────

    def retirer(self, histoire: str) -> int:
        """Supprime les jeux de l'histoire (et leurs alertes) et son rapport d'exemple ; renvoie le nombre de jeux."""
        part = self._part(histoire)
        datasets = self._datasets(histoire)
        for d in datasets:
            self.store.remove(d.id)
            self.alerts.forget_dataset(d.id)
        rapport = REPORT_PREFIX + part["histoire"]["titre"]
        for r in self.reports.list():
            if r.name == rapport:
                self.reports.delete(r.id)
        return len(datasets)
