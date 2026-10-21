"""Réponse à une question (ou explication d'un écart), vérifiée chiffre par chiffre.

Le frontend a déjà choisi et calculé le visuel qui répond (constructeur de visuels + moteur de
requêtes) et en a tiré des faits écrits comme à l'écran. L'IA rédige une réponse courte en ne
recopiant que ces chiffres ; chaque nombre est vérifié comme dans la synthèse de page (`summary.py`) :
une relance au plus, puis retrait des phrases invérifiables.
"""

import json
import re

from app.schemas.ai import ChatMessage
from app.schemas.summary import AnswerRequest, AnswerResponse
from app.services.ai.base import AIProviderError
from app.services.ai.service import AIService
from app.services.ai.summary import Number, numbers, tidy, ungrounded
from app.services.data.context import DATA_RULE, data_block

RULES = {
    "question": """Tu réponds à la question d'un utilisateur d'un outil de BI à partir de faits chiffrés.
Règles :
- réponds en 1 à 3 phrases, en commençant par la réponse directe (le chiffre ou le nom demandé) ;
- utilise UNIQUEMENT les faits fournis ; recopie chaque nombre exactement comme il est écrit (unités et % compris) ;
- ne calcule aucun nouveau chiffre ; n'invente ni cause, ni contexte, ni prévision ;
- si les faits ne permettent pas de répondre, dis-le simplement et indique ce que montrent les faits ;
- français, ton sobre, sans Markdown ni emoji.
""",
    "explain": """Tu expliques un écart observé dans un rapport de BI à partir d'une décomposition chiffrée.
Règles :
- 2 à 4 phrases : l'écart, puis les principaux contributeurs (du plus fort au plus faible),
  puis ce qui compense s'il y a lieu ;
- utilise UNIQUEMENT les faits fournis ; recopie chaque nombre exactement comme il est écrit (unités et % compris) ;
- ne calcule aucun nouveau chiffre ; parle de contributions, pas de causes extérieures ; aucune prévision ;
- français, ton sobre, sans Markdown ni emoji.
""",
}
SCHEMA = {"type": "object", "properties": {"answer": {"type": "string"}}, "required": ["answer"]}
ANSWER_MAX = 900
SENTENCE = re.compile(r"(?<=[.!?])\s+(?=[A-ZÀ-ÖØ-Þ«(])")


def facts_text(req: AnswerRequest) -> str:
    lines = [f"Question : {req.question}"]
    lines.append(f"Filtres actifs : {' ; '.join(req.filters)}" if req.filters else "Filtres actifs : aucun")
    for v in req.visuals:
        lines.append(f"\nVisuel « {v.title} » ({v.type})")
        lines.extend(f"- {f}" for f in v.facts)
    return "\n".join(lines)


def allowed(req: AnswerRequest) -> list[Number]:
    texts = [req.question, *req.filters]
    for v in req.visuals:
        texts.append(v.title)
        texts.extend(v.facts)
    return [n for t in texts for n in numbers(t)]


def _text(raw: dict) -> str:
    value = raw.get("answer")
    return tidy(value, ANSWER_MAX) if isinstance(value, str) else ""


async def answer(service: AIService, req: AnswerRequest) -> AnswerResponse:
    """Réponse vérifiée : une relance au plus, puis retrait des phrases au chiffre introuvable."""
    pool = allowed(req)
    system = RULES[req.kind] + DATA_RULE
    messages = [ChatMessage(role="user", content=f"Faits :\n{data_block(facts_text(req))}")]
    provider, raw = await service.chat_json(req.provider, messages, system, SCHEMA)
    text = _text(raw)
    bad = ungrounded(text, pool)
    if not text or bad:
        problem = "La réponse est vide." if not text else f"Chiffres absents des faits : {', '.join(bad)}."
        retry = messages + [
            ChatMessage(role="assistant", content=json.dumps(raw, ensure_ascii=False)[:4000]),
            ChatMessage(role="user", content=f"{problem} Réécris en recopiant uniquement des chiffres des faits."),
        ]
        try:
            provider, raw2 = await service.chat_json(req.provider, retry, system, SCHEMA)
            text2 = _text(raw2)
            if text2 and len(ungrounded(text2, pool)) <= len(bad):
                text = text2
        except AIProviderError:
            pass

    warnings: list[str] = []
    kept = []
    for sentence in SENTENCE.split(text):
        if not sentence.strip():
            continue
        if wrong := ungrounded(sentence, pool):
            warnings.append(f"Phrase écartée (chiffre non vérifiable : {', '.join(wrong)}) : {sentence}")
        else:
            kept.append(sentence.strip())
    if not kept:
        raise AIProviderError(provider.name, "L'IA n'a produit aucune réponse vérifiable à partir des chiffres.", 422)
    return AnswerResponse(answer=" ".join(kept), provider=provider.name, model=provider.model, warnings=warnings)
