"""Nœud Atelier (docs/SUITE.md §7) : manifeste, tables d'échange, requêtes, upsert et journal d'événements.

Routes minces : la logique est dans `app/services/atelier/`. Erreurs au format `{detail, code}` (§7.5),
posées par les gestionnaires de `main.py` pour tout chemin `/api/atelier/*`.
"""

import asyncio
from typing import Annotated

from fastapi import APIRouter, Header, Query, Response, status
from fastapi.responses import JSONResponse

from app.api.deps import AtelierDep, IdempotencyDep, JournalDep
from app.schemas.atelier import (
    EVENTS_DEFAULT_LIMIT,
    EVENTS_MAX_LIMIT,
    TABLE_DEFAULT_LIMIT,
    TABLE_MAX_LIMIT,
    AtelierEventsPage,
    AtelierManifest,
    AtelierTable,
    UpsertTableInput,
    UpsertTableResult,
)
from app.schemas.query import QueryRequest
from app.services.atelier.errors import AtelierError
from app.services.atelier.idempotency import MAX_KEY_LENGTH, fingerprint
from app.services.atelier.manifest import build_manifest

router = APIRouter(prefix="/atelier", tags=["atelier"])

UPSERT_SCOPE = "datasets.upsert_table"


@router.get("/manifest", response_model=AtelierManifest, response_model_by_alias=True)
async def manifest() -> AtelierManifest:
    """Ce qu'Atelier Viz sait faire dans un workflow (actions, événements) — sans secret ni donnée."""
    return build_manifest()


@router.get("/datasets/{dataset_id}/table", response_model=AtelierTable)
async def dataset_table(
    dataset_id: str,
    atelier: AtelierDep,
    offset: Annotated[int, Query(ge=0)] = 0,
    limit: Annotated[int, Query(ge=1, le=TABLE_MAX_LIMIT)] = TABLE_DEFAULT_LIMIT,
) -> AtelierTable:
    """Page de lignes d'un jeu au format `atelier-table/1` (`truncated` si d'autres lignes existent)."""
    return await asyncio.to_thread(atelier.table, dataset_id, offset, limit)


@router.post("/query", response_model=AtelierTable)
async def query(req: QueryRequest, atelier: AtelierDep) -> AtelierTable:
    """Même corps que `POST /api/query` (moteur des visuels), résultat en `atelier-table/1` à clés snake_case."""
    return await asyncio.to_thread(atelier.query, req)


@router.post(
    "/datasets",
    response_model=UpsertTableResult,
    status_code=status.HTTP_201_CREATED,
    responses={200: {"model": UpsertTableResult, "description": "Jeu existant mis à jour."}},
)
async def upsert_table(
    body: UpsertTableInput,
    atelier: AtelierDep,
    idempotency: IdempotencyDep,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> Response:
    """Crée un jeu (201) ou remplace les données du jeu de cette clé (200). `Idempotency-Key` accepté (§7.4)."""
    if idempotency_key is None:
        result = await asyncio.to_thread(atelier.upsert, body)
        return _result(result)
    if not 1 <= len(idempotency_key) <= MAX_KEY_LENGTH or not idempotency_key.isprintable():
        raise AtelierError(422, "VALIDATION", f"En-tête Idempotency-Key invalide (1 à {MAX_KEY_LENGTH} caractères).")
    fp = fingerprint(body.model_dump(mode="json"))
    async with idempotency.lock(UPSERT_SCOPE, idempotency_key):
        stored = await asyncio.to_thread(idempotency.lookup, UPSERT_SCOPE, idempotency_key)
        if stored is not None:
            if stored.fingerprint != fp:
                raise AtelierError(
                    409,
                    "IDEMPOTENCY_KEY_REUSED",
                    "Cette clé d'idempotence a déjà servi pour une autre requête : utilisez une nouvelle clé.",
                )
            return JSONResponse(stored.body, status_code=stored.status_code, headers={"Idempotency-Replayed": "true"})
        result = await asyncio.to_thread(atelier.upsert, body)
        response = _result(result)
        await asyncio.to_thread(
            idempotency.save, UPSERT_SCOPE, idempotency_key, fp, response.status_code, result.model_dump(mode="json")
        )
        return response


def _result(result: UpsertTableResult) -> JSONResponse:
    code = status.HTTP_201_CREATED if result.action == "created" else status.HTTP_200_OK
    return JSONResponse(result.model_dump(mode="json"), status_code=code)


@router.get("/events", response_model=AtelierEventsPage, response_model_exclude_none=True)
async def events(
    journal: JournalDep,
    since: Annotated[int | None, Query(ge=0, description="Dernier seq déjà lu (exclusif).")] = None,
    limit: Annotated[int, Query(ge=1, le=EVENTS_MAX_LIMIT)] = EVENTS_DEFAULT_LIMIT,
    types: Annotated[str | None, Query(max_length=2000, description="Types séparés par des virgules.")] = None,
) -> AtelierEventsPage:
    """Événements après `since` (ou les plus récents) ; `gap: true` si des événements ont été perdus."""
    wanted = {t.strip() for t in types.split(",") if t.strip()} if types else None
    return await asyncio.to_thread(journal.page, since, limit, wanted)
