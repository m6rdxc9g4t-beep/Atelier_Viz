"""Endpoints de l'assistant IA hybride."""

from fastapi import APIRouter

from app.api.deps import AIServiceDep, StoreDep
from app.api.routes.datasets import get_or_404
from app.schemas.ai import ChatRequest, ChatResponse, ProvidersResponse
from app.schemas.builder import BuildRequest, BuildResponse, RepairRequest, RepairResponse
from app.schemas.summary import AnswerRequest, AnswerResponse, SummaryRequest, SummaryResponse
from app.services.ai.answer import answer
from app.services.ai.builder import build_visuals, repair_existing
from app.services.ai.summary import summarize
from app.services.data.context import with_dataset

router = APIRouter(prefix="/ai", tags=["ai"])


@router.get("/providers", response_model=ProvidersResponse)
async def providers(service: AIServiceDep, refresh: bool = False) -> ProvidersResponse:
    """Disponibilité d'Ollama (serveur + modèle installé) et de Claude (mode en ligne + CLI connectée ou clé API).

    L'état de la CLI Claude est gardé 60 s ; `?refresh=true` le revérifie tout de suite (au plus toutes les 10 s).
    """
    return await service.providers_status(refresh)


@router.post("/chat", response_model=ChatResponse)
async def chat(payload: ChatRequest, service: AIServiceDep, store: StoreDep) -> ChatResponse:
    """Envoie une conversation au fournisseur choisi (ou routé automatiquement).

    Si `dataset_id` est fourni, le schéma et un échantillon du jeu de données (jamais les données complètes)
    sont joints au **dernier message de l'utilisateur**, jamais au prompt système : celui-ci part en argument
    de la CLI Claude, visible par `ps` (docs/SUITE.md §5.3).
    """
    if payload.dataset_id:
        dataset = await get_or_404(store, payload.dataset_id)
        payload = payload.model_copy(update={"messages": with_dataset(payload.messages, dataset.profile())})
    return await service.chat(payload)


@router.post("/visuals", response_model=BuildResponse)
async def build(payload: BuildRequest, service: AIServiceDep, store: StoreDep) -> BuildResponse:
    """Crée des visuels à partir d'une phrase. Le schéma et 5 lignes du jeu de données sont envoyés à l'IA."""
    dataset = await get_or_404(store, payload.dataset_id)
    return await build_visuals(service, payload, dataset.profile())


@router.post("/visuals/repair", response_model=RepairResponse)
async def repair(payload: RepairRequest, store: StoreDep) -> RepairResponse:
    """Revalide des visuels proposés plus tôt (historique « Créer avec l'IA ») avant de les ajouter de nouveau.

    Aucun appel à l'IA : seulement la validation / réparation contre le profil actuel du jeu.
    """
    dataset = await get_or_404(store, payload.dataset_id)
    return repair_existing(payload, dataset.profile())


@router.post("/summary", response_model=SummaryResponse)
async def summary(payload: SummaryRequest, service: AIServiceDep) -> SummaryResponse:
    """Synthèse d'une page. Seuls les faits agrégés envoyés par le frontend partent vers l'IA ;
    chaque chiffre de la réponse est vérifié contre ces faits."""
    return await summarize(service, payload)


@router.post("/answer", response_model=AnswerResponse)
async def answer_question(payload: AnswerRequest, service: AIServiceDep) -> AnswerResponse:
    """Réponse à une question (ou explication d'un écart) à partir des faits calculés par le frontend ;
    chaque chiffre de la réponse est vérifié contre ces faits."""
    return await answer(service, payload)
