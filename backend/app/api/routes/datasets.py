"""Import et consultation des jeux de données (persistés dans DuckDB)."""

import asyncio
from typing import Annotated

from fastapi import APIRouter, File, HTTPException, Query, Response, UploadFile, status

from app.api.deps import AlertsDep, SchedulerDep, SettingsDep, StoreDep
from app.schemas.dataset import (
    DatasetModel,
    DatasetProfile,
    DatasetRows,
    DatasetSummary,
    ExpressionCheck,
    ExpressionResult,
    PrepPreview,
    PrepRequest,
    Relation,
    RelationCheck,
)
from app.services.data import DatasetError, DatasetStore, StoredDataset, read_table
from app.services.data.model import ModelError

router = APIRouter(prefix="/datasets", tags=["datasets"])


async def get_or_404(store: DatasetStore, dataset_id: str) -> StoredDataset:
    dataset = await asyncio.to_thread(store.get, dataset_id)
    if dataset is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Jeu de données « {dataset_id} » introuvable.")
    return dataset


@router.post("", response_model=DatasetProfile, status_code=status.HTTP_201_CREATED)
async def upload_dataset(
    store: StoreDep,
    settings: SettingsDep,
    file: Annotated[UploadFile, File(description="Fichier CSV, XLSX ou JSON")],
) -> DatasetProfile:
    """Importe un fichier, infère les types de colonnes, l'enregistre et retourne son profil."""
    max_bytes = settings.max_upload_mb * 1024 * 1024
    content = await file.read(max_bytes + 1)
    if len(content) > max_bytes:
        raise HTTPException(
            status.HTTP_413_CONTENT_TOO_LARGE, f"Fichier trop volumineux (max {settings.max_upload_mb} Mo)."
        )
    filename = file.filename or "donnees.csv"
    try:
        df, fmt = await asyncio.to_thread(read_table, filename, content)
    except DatasetError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc
    dataset = await asyncio.to_thread(store.add, filename, fmt, df)
    return dataset.profile()


@router.get("", response_model=list[DatasetSummary])
async def list_datasets(store: StoreDep) -> list[DatasetSummary]:
    """Jeux de données importés, du plus récent au plus ancien."""
    return [d.summary() for d in await asyncio.to_thread(store.list)]


@router.get("/{dataset_id}", response_model=DatasetProfile)
async def get_dataset(dataset_id: str, store: StoreDep) -> DatasetProfile:
    """Profil complet : colonnes typées, statistiques, échantillon."""
    return (await get_or_404(store, dataset_id)).profile()


@router.get("/{dataset_id}/rows", response_model=DatasetRows)
async def get_rows(
    dataset_id: str,
    store: StoreDep,
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=1000)] = 100,
) -> DatasetRows:
    """Lignes paginées, pour l'aperçu tabulaire."""
    dataset = await get_or_404(store, dataset_id)
    return await asyncio.to_thread(store.rows, dataset, offset, limit)


@router.put("/{dataset_id}/model", response_model=DatasetProfile)
async def save_model(dataset_id: str, model: DatasetModel, store: StoreDep) -> DatasetProfile:
    """Enregistre les colonnes et mesures calculées (tout est validé ; rien n'est modifié en cas d'erreur)."""
    dataset = await get_or_404(store, dataset_id)
    try:
        updated = await asyncio.to_thread(store.set_model, dataset, model)
    except ModelError as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            {"message": "Le modèle contient des erreurs.", "issues": [i.model_dump() for i in exc.issues]},
        ) from exc
    return updated.profile()


@router.put("/{dataset_id}/steps", response_model=DatasetProfile)
async def save_steps(dataset_id: str, body: PrepRequest, store: StoreDep) -> DatasetProfile:
    """Enregistre les étapes de préparation et les applique à la source (rejouées à chaque actualisation)."""
    dataset = await get_or_404(store, dataset_id)
    try:
        updated = await asyncio.to_thread(store.set_steps, dataset, body.steps)
    except ModelError as exc:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            {"message": "Les étapes ne peuvent pas être appliquées.", "issues": [i.model_dump() for i in exc.issues]},
        ) from exc
    return updated.profile()


@router.post("/{dataset_id}/steps/preview", response_model=PrepPreview)
async def preview_steps(dataset_id: str, body: PrepRequest, store: StoreDep) -> PrepPreview:
    """Aperçu du résultat des étapes (rien n'est enregistré) ; erreur localisée sur l'étape fautive."""
    dataset = await get_or_404(store, dataset_id)
    return await asyncio.to_thread(store.preview_steps, dataset, body.steps)


@router.post("/{dataset_id}/relations/check", response_model=RelationCheck)
async def check_relation(dataset_id: str, relation: Relation, store: StoreDep) -> RelationCheck:
    """Correspondance des clés d'une relation avant enregistrement (lignes trouvées, doublons)."""
    dataset = await get_or_404(store, dataset_id)
    return await asyncio.to_thread(store.check_relation, dataset, relation)


@router.post("/{dataset_id}/model/check", response_model=ExpressionResult)
async def check_expression(dataset_id: str, check: ExpressionCheck, store: StoreDep) -> ExpressionResult:
    """Vérifie une expression pendant la saisie : erreur localisée, type et aperçu des valeurs."""
    dataset = await get_or_404(store, dataset_id)
    return await asyncio.to_thread(store.check, dataset, check)


@router.post("/{dataset_id}/refresh", response_model=DatasetProfile)
async def refresh_dataset(dataset_id: str, store: StoreDep, scheduler: SchedulerDep) -> DatasetProfile:
    """Relit la source d'un jeu importé depuis une connexion (même identifiant : les rapports suivent).

    Passe par l'ordonnanceur : une seule actualisation à la fois par jeu, inscrite au journal.
    """
    await get_or_404(store, dataset_id)
    try:
        await scheduler.run(dataset_id, "manual", raise_errors=True)
    except ModelError as exc:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            {
                "message": "Les nouvelles données ne correspondent plus au modèle (colonne disparue ?) : "
                "rien n'a changé.",
                "issues": [i.model_dump() for i in exc.issues],
            },
        ) from exc
    return (await get_or_404(store, dataset_id)).profile()


@router.delete("/{dataset_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_dataset(dataset_id: str, store: StoreDep, scheduler: SchedulerDep, alerts: AlertsDep) -> Response:
    """Supprime définitivement un jeu de données (et sa planification d'actualisation, ses alertes)."""
    if not await asyncio.to_thread(store.remove, dataset_id):
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Jeu de données « {dataset_id} » introuvable.")
    await asyncio.to_thread(scheduler.forget, dataset_id)
    await asyncio.to_thread(alerts.forget_dataset, dataset_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
