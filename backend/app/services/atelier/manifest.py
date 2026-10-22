"""Manifeste du nœud Atelier Viz (docs/SUITE.md §7.1), `GET /api/atelier/manifest`.

Les `input_schema` et `output.schema` sont générés à partir des modèles Pydantic des routes
(JSON Schema draft 2020-12, propriétés en snake_case) : le manifeste ne peut pas diverger de l'API.
Ajouter une action : une entrée de `_ACTIONS` (identifiant stable, jamais renommé) + un test.
Ajouter un événement : une entrée de `EVENT_TYPES` (`app/schemas/atelier.py`), émise par `AtelierEvents`.
"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, TypeAdapter

from app import __version__
from app.schemas.alert import Alert
from app.schemas.atelier import (
    EVENT_TYPES,
    AlertsListInput,
    AtelierManifest,
    AtelierTable,
    DatasetIdInput,
    ManifestAction,
    ManifestEvent,
    ManifestHttp,
    ManifestOutput,
    NoInput,
    TablePageInput,
    UpsertTableInput,
    UpsertTableResult,
)
from app.schemas.dataset import DatasetProfile, DatasetSummary
from app.schemas.query import QueryRequest
from app.schemas.report import ReportSummary

Kind = Literal["read", "write", "destructive"]
Idem = Literal["header", "field", "natural", "none"]


def input_schema(model: type[BaseModel]) -> dict[str, Any]:
    """Schéma d'entrée d'une action (objet, propriétés snake_case)."""
    schema = model.model_json_schema(mode="validation")
    schema.setdefault("properties", {})
    schema.setdefault("required", [])
    return schema


def output_schema(tp: Any) -> dict[str, Any]:
    """Schéma de sortie (modèle ou liste de modèles)."""
    return TypeAdapter(tp).json_schema(mode="serialization")


def _action(
    id_: str,
    label: str,
    description: str,
    kind: Kind,
    method: Literal["GET", "POST"],
    path: str,
    model: type[BaseModel],
    fmt: Literal["atelier-table/1", "json"],
    out: Any,
    idempotency: Idem,
) -> ManifestAction:
    return ManifestAction(
        id=id_,
        label=label,
        description=description,
        kind=kind,
        http=ManifestHttp(method=method, path=path),
        input_schema=input_schema(model),
        output=ManifestOutput(format=fmt, schema=output_schema(out)),
        idempotency=idempotency,
    )


def _actions() -> list[ManifestAction]:
    return [
        _action(
            "datasets.list",
            "Lister les jeux de données",
            "Jeux de données importés dans Atelier Viz, du plus récent au plus ancien (sans leurs lignes).",
            "read",
            "GET",
            "/api/datasets",
            NoInput,
            "json",
            list[DatasetSummary],
            "natural",
        ),
        _action(
            "datasets.get",
            "Lire le profil d'un jeu",
            "Colonnes typées, statistiques et premières lignes d'un jeu de données.",
            "read",
            "GET",
            "/api/datasets/{dataset_id}",
            DatasetIdInput,
            "json",
            DatasetProfile,
            "natural",
        ),
        _action(
            "datasets.table",
            "Lire les lignes d'un jeu",
            "Page de lignes d'un jeu (colonnes calculées et liées comprises), au plus 5 000 par appel.",
            "read",
            "GET",
            "/api/atelier/datasets/{dataset_id}/table",
            TablePageInput,
            "atelier-table/1",
            AtelierTable,
            "natural",
        ),
        _action(
            "datasets.query",
            "Interroger un jeu de données",
            "Regroupe, agrège, filtre et trie un jeu avec le moteur de requêtes des visuels (aucun SQL accepté).",
            "read",
            "POST",
            "/api/atelier/query",
            QueryRequest,
            "atelier-table/1",
            AtelierTable,
            "natural",
        ),
        _action(
            "datasets.upsert_table",
            "Créer ou remplacer un jeu à partir d'une table",
            "Crée un jeu à partir d'une table atelier-table/1, ou remplace les données du jeu qui porte déjà "
            "cette clé (le modèle et les rapports branchés sont conservés et revalidés).",
            "write",
            "POST",
            "/api/atelier/datasets",
            UpsertTableInput,
            "json",
            UpsertTableResult,
            "header",
        ),
        _action(
            "datasets.refresh",
            "Actualiser un jeu",
            "Relit la source d'un jeu importé depuis une connexion (même identifiant : les rapports suivent).",
            "write",
            "POST",
            "/api/datasets/{dataset_id}/refresh",
            DatasetIdInput,
            "json",
            DatasetProfile,
            "natural",
        ),
        _action(
            "reports.list",
            "Lister les rapports",
            "Rapports d'Atelier Viz (nom, pages, visuels, date de modification).",
            "read",
            "GET",
            "/api/reports",
            NoInput,
            "json",
            list[ReportSummary],
            "natural",
        ),
        _action(
            "alerts.list",
            "Lister les alertes",
            "Alertes sur seuil (règle, état, historique des évaluations), éventuellement d'un seul jeu.",
            "read",
            "GET",
            "/api/alerts",
            AlertsListInput,
            "json",
            list[Alert],
            "natural",
        ),
    ]


def _events() -> list[ManifestEvent]:
    return [
        ManifestEvent(type=type_, label=label, data_schema=input_schema(model))
        for type_, (label, _, model) in EVENT_TYPES.items()
    ]


def build_manifest() -> AtelierManifest:
    """Manifeste complet d'Atelier Viz (sans secret ni donnée utilisateur)."""
    return AtelierManifest(
        app="viz",
        name="Atelier Viz",
        version=__version__,
        transport="http",
        actions=_actions(),
        events=_events(),
    )
