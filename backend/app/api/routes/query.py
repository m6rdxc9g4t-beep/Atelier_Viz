"""Requêtes d'agrégation exécutées par les visuels."""

import asyncio

from fastapi import APIRouter

from app.api.deps import DatabaseDep, StoreDep
from app.api.routes.datasets import get_or_404
from app.schemas.query import QueryRequest, QueryResponse
from app.services.engine import run_query

router = APIRouter(tags=["query"])


@router.post("/query", response_model=QueryResponse)
async def query(req: QueryRequest, store: StoreDep, db: DatabaseDep) -> QueryResponse:
    """Regroupe, agrège, filtre et trie un jeu de données (SQL DuckDB généré côté serveur)."""
    dataset = await get_or_404(store, req.dataset_id)
    return await asyncio.to_thread(run_query, db, dataset.source, dataset.profile(), req)
