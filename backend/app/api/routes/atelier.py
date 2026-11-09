"""Nœud Atelier (docs/SUITE.md §7) : manifeste, tables d'échange, requêtes, upsert et journal d'événements.

Routes minces : la logique est dans `app/services/atelier/`. Erreurs au format `{detail, code}` (§7.5),
posées par les gestionnaires de `main.py` pour tout chemin `/api/atelier/*`.
"""

import asyncio
import json
import time
from collections.abc import Awaitable, Callable
from typing import Annotated, Any

from fastapi import APIRouter, Header, Query, Request, Response, status
from fastapi.responses import JSONResponse, StreamingResponse

from app.api.deps import AtelierDep, AtelierWritesDep, IdempotencyDep, JournalDep
from app.schemas.alert import Alert, AlertInput
from app.schemas.atelier import (
    EVENTS_DEFAULT_LIMIT,
    EVENTS_MAX_LIMIT,
    TABLE_DEFAULT_LIMIT,
    TABLE_MAX_LIMIT,
    AlertEnabledInput,
    AtelierEventsPage,
    AtelierManifest,
    AtelierTable,
    ReportDuplicateInput,
    ReportDuplicateResult,
    UpsertTableInput,
    UpsertTableResult,
)
from app.schemas.query import QueryRequest
from app.services.atelier.errors import AtelierError
from app.services.atelier.idempotency import MAX_KEY_LENGTH, fingerprint
from app.services.atelier.manifest import build_manifest
from app.services.atelier.stream import event_stream

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

    async def run() -> JSONResponse:
        return _result(await asyncio.to_thread(atelier.upsert, body))

    return await _idempotent(UPSERT_SCOPE, idempotency_key, body.model_dump(mode="json"), idempotency, run)


async def _idempotent(
    scope: str,
    key: str | None,
    body: Any,
    idempotency: Any,
    run: Callable[[], Awaitable[JSONResponse]],
) -> JSONResponse:
    """Écriture rejouable (§7.4) : même clé + même corps → même réponse ; autre corps → 409."""
    if key is None:
        return await run()
    if not 1 <= len(key) <= MAX_KEY_LENGTH or not key.isprintable():
        raise AtelierError(422, "VALIDATION", f"En-tête Idempotency-Key invalide (1 à {MAX_KEY_LENGTH} caractères).")
    fp = fingerprint(body)
    async with idempotency.lock(scope, key):
        stored = await asyncio.to_thread(idempotency.lookup, scope, key)
        if stored is not None:
            if stored.fingerprint != fp:
                raise AtelierError(
                    409,
                    "IDEMPOTENCY_KEY_REUSED",
                    "Cette clé d'idempotence a déjà servi pour une autre requête : utilisez une nouvelle clé.",
                )
            return JSONResponse(stored.body, status_code=stored.status_code, headers={"Idempotency-Replayed": "true"})
        response = await run()
        await asyncio.to_thread(idempotency.save, scope, key, fp, response.status_code, _json(response))
        return response


def _json(response: JSONResponse) -> Any:
    return json.loads(bytes(response.body))


@router.post("/reports/duplicate", response_model=ReportDuplicateResult, status_code=status.HTTP_201_CREATED)
async def duplicate_report(
    body: ReportDuplicateInput,
    writes: AtelierWritesDep,
    idempotency: IdempotencyDep,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> Response:
    """Copie d'un rapport, rebranchée au besoin sur un autre jeu (signets personnels exclus)."""

    async def run() -> JSONResponse:
        result = await asyncio.to_thread(writes.duplicate_report, body)
        return JSONResponse(result.model_dump(mode="json"), status_code=status.HTTP_201_CREATED)

    return await _idempotent("reports.duplicate", idempotency_key, body.model_dump(mode="json"), idempotency, run)


@router.post("/alerts", response_model=Alert, status_code=status.HTTP_201_CREATED)
async def create_alert(
    body: AlertInput,
    writes: AtelierWritesDep,
    idempotency: IdempotencyDep,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> Response:
    """Crée une alerte sur seuil (mesure vérifiée par le moteur). `Idempotency-Key` accepté (§7.4)."""

    async def run() -> JSONResponse:
        alert = await asyncio.to_thread(writes.create_alert, body)
        return JSONResponse(alert.model_dump(mode="json"), status_code=status.HTTP_201_CREATED)

    return await _idempotent("alerts.create", idempotency_key, body.model_dump(mode="json"), idempotency, run)


@router.post("/alerts/{alert_id}/enabled", response_model=Alert)
async def set_alert_enabled(alert_id: str, body: AlertEnabledInput, writes: AtelierWritesDep) -> Alert:
    """Active ou met en pause une alerte (rejouer donne le même état)."""
    if body.alert_id != alert_id:
        raise AtelierError(422, "VALIDATION", "L'identifiant du corps ne correspond pas au chemin.")
    return await asyncio.to_thread(writes.set_alert_enabled, alert_id, body.enabled)


@router.post("/alerts/{alert_id}/evaluate", response_model=Alert)
async def evaluate_alert(alert_id: str, writes: AtelierWritesDep) -> Alert:
    """Évalue une alerte maintenant (ses actions partent si le seuil est franchi)."""
    return await writes.evaluate_alert(alert_id)


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


@router.get("/events/stream", response_class=StreamingResponse)
async def events_stream(
    request: Request,
    journal: JournalDep,
    since: Annotated[int | None, Query(ge=0, description="Dernier seq déjà lu (exclusif).")] = None,
    types: Annotated[str | None, Query(max_length=2000, description="Types séparés par des virgules.")] = None,
    timeout: Annotated[float, Query(ge=0, le=3600, description="Durée de la connexion (s) avant reconnexion.")] = 3600,
    last_event_id: Annotated[str | None, Header(alias="Last-Event-ID")] = None,
) -> StreamingResponse:
    """Flux poussé des événements (Server-Sent Events) ; `Last-Event-ID` reprend où la connexion s'était arrêtée."""
    if since is None and last_event_id is not None and last_event_id.isdigit():
        since = int(last_event_id)
    wanted = {t.strip() for t in types.split(",") if t.strip()} if types else None
    stream = event_stream(journal, since, wanted, timeout, request.is_disconnected, asyncio.sleep, time.monotonic)
    return StreamingResponse(
        stream,
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
