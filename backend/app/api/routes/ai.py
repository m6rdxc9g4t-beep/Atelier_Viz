"""Endpoints de l'assistant IA hybride."""

from fastapi import APIRouter

from app.api.deps import AIServiceDep, StoreDep
from app.api.routes.datasets import get_or_404
from app.schemas.ai import ChatRequest, ChatResponse, ProvidersResponse
from app.services.data.context import dataset_context

router = APIRouter(prefix="/ai", tags=["ai"])


@router.get("/providers", response_model=ProvidersResponse)
async def providers(service: AIServiceDep) -> ProvidersResponse:
    """Disponibilité d'Ollama (serveur + modèle installé) et de Claude (mode en ligne + CLI connectée ou clé API)."""
    return await service.providers_status()


@router.post("/chat", response_model=ChatResponse)
async def chat(payload: ChatRequest, service: AIServiceDep, store: StoreDep) -> ChatResponse:
    """Envoie une conversation au fournisseur choisi (ou routé automatiquement).

    Si `dataset_id` est fourni, le schéma et un échantillon du jeu de données
    sont ajoutés au prompt système (jamais les données complètes).
    """
    if payload.dataset_id:
        dataset = await get_or_404(store, payload.dataset_id)
        context = dataset_context(dataset.profile())
        system = f"{payload.system}\n\n{context}" if payload.system else context
        payload = payload.model_copy(update={"system": system})
    return await service.chat(payload)
