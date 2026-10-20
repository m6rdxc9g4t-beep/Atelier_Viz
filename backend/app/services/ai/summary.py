"""Résumé d'une page par l'IA, vérifié chiffre par chiffre.

1. Le frontend envoie des faits calculés (« Total : 4,4 M », « 1er : Occitanie — 974 k (22 % du total) »).
2. L'IA rédige un titre et quelques points, en ne recopiant que ces chiffres (sortie JSON contrainte).
3. Chaque nombre du texte est comparé aux faits (à la précision écrite près). Un chiffre introuvable
   déclenche une relance avec la liste des écarts ; ce qui reste invérifiable est écarté.
"""

import json
import re
from dataclasses import dataclass
from typing import Any

from app.schemas.ai import ChatMessage
from app.schemas.summary import SummaryPoint, SummaryRequest, SummaryResponse
from app.services.ai.base import AIProviderError
from app.services.ai.service import AIService

RULES = """Tu rédiges la synthèse d'une page de rapport de BI pour un lecteur métier pressé.
Règles :
- utilise UNIQUEMENT les faits fournis ; recopie chaque nombre exactement comme il est écrit (unités et % compris) ;
- ne calcule aucun nouveau chiffre (pas de somme, d'écart ni de pourcentage de ton cru) ;
- n'invente ni cause, ni contexte extérieur, ni prévision : décris des constats (« le plus élevé », « en hausse ») ;
- headline : une phrase de 90 caractères au plus, qui dit l'essentiel ;
- points : du plus important au moins important, une phrase chacun ; « visuels » = numéros des visuels concernés ;
- français, ton sobre, sans Markdown ni emoji."""

HEADLINE_MAX = 140
POINT_MAX = 300

NUMBER = re.compile(
    r"(?<![\w,.])([+\-−]?)(\d{1,3}(?:[   ]\d{3})+|\d+)(?:[.,](\d+))?"
    r"[   ]?(%|Md|mds?|milliards?|M|millions?|k|K|milliers?)?(?!\w)",
)
# Unités en minuscules : « M » devient « m » (le motif n'accepte que la majuscule, pas de confusion avec « mètre »).
UNITS = {"k": 1e3, "millier": 1e3, "milliers": 1e3, "m": 1e6, "million": 1e6, "millions": 1e6}
BILLIONS = {"md", "mds", "milliard", "milliards"}


@dataclass(frozen=True)
class Number:
    """Nombre lu dans un texte : valeur, demi-unité du dernier chiffre écrit, pourcentage ou non."""

    text: str
    value: float
    precision: float
    percent: bool
    bare_integer: bool


def numbers(text: str) -> list[Number]:
    """Extrait les nombres écrits à la française (« 1 234,5 », « 4,4 M », « +48 % », « 2 millions »)."""
    found: list[Number] = []
    for m in NUMBER.finditer(text):
        _sign, whole, frac, unit = m.groups()
        digits = re.sub(r"\D", "", whole)
        value = float(f"{digits}.{frac}" if frac else digits)
        u = (unit or "").lower()
        scale = 1e9 if u in BILLIONS else UNITS.get(u, 1.0)
        precision = 0.5 * 10 ** (-len(frac or "")) * scale
        found.append(
            Number(
                text=m.group(0).strip(),
                value=value * scale,
                precision=precision,
                percent=unit == "%",
                bare_integer=not frac and not unit,
            )
        )
    return found


def allowed_numbers(req: SummaryRequest) -> list[Number]:
    texts = [req.report, req.page, *req.filters]
    for v in req.visuals:
        texts.append(v.title)
        texts.extend(v.facts)
    return [n for t in texts for n in numbers(t)]


def grounded(n: Number, pool: list[Number]) -> bool:
    """Le nombre figure-t-il dans les faits (à la précision écrite près) ?"""
    if n.bare_integer and not n.percent and (n.value <= 10 or 1900 <= n.value <= 2100):
        return True  # dénombrements (« les 3 premiers ») et années
    for f in pool:
        if f.percent != n.percent:
            continue
        tolerance = max(n.precision, f.precision) + 1e-9 * max(abs(n.value), abs(f.value), 1)
        if abs(n.value - f.value) <= tolerance:
            return True
    return False


def ungrounded(text: str, pool: list[Number]) -> list[str]:
    return [n.text for n in numbers(text) if not grounded(n, pool)]


def facts_text(req: SummaryRequest) -> str:
    lines = [f"Rapport : {req.report}", f"Page : {req.page}"]
    lines.append(
        f"Filtres actifs : {' ; '.join(req.filters)}" if req.filters else "Filtres actifs : aucun (toutes les données)"
    )
    for i, v in enumerate(req.visuals, start=1):
        lines.append(f"\nVisuel {i} — « {v.title} » ({v.type})")
        lines.extend(f"- {f}" for f in v.facts)
    return "\n".join(lines)


def summary_schema(req: SummaryRequest) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "headline": {"type": "string"},
            "points": {
                "type": "array",
                "minItems": 1,
                "maxItems": req.max_points,
                "items": {
                    "type": "object",
                    "properties": {
                        "text": {"type": "string"},
                        "visuels": {
                            "type": "array",
                            "items": {"type": "integer", "minimum": 1, "maximum": len(req.visuals)},
                        },
                    },
                    "required": ["text"],
                },
            },
        },
        "required": ["headline", "points"],
    }


@dataclass
class Draft:
    headline: str
    points: list[SummaryPoint]
    errors: list[str]


def tidy(text: str, limit: int) -> str:
    """Espaces normalisés, insécables avant %, k, M, Md (« +48 % » ne se coupe pas en fin de ligne)."""
    text = re.sub(r"[ \t\r\n]+", " ", text).strip()
    return re.sub(r"(\d) (%|k|M|Md)(?!\w)", "\\1\u00a0\\2", text)[:limit]


def check(raw: dict[str, Any], req: SummaryRequest, pool: list[Number]) -> Draft:
    """Nettoie la réponse et liste les chiffres absents des faits."""
    headline = raw.get("headline")
    headline = tidy(headline, HEADLINE_MAX) if isinstance(headline, str) else ""
    errors: list[str] = []
    if not headline:
        errors.append("Le titre (headline) est vide.")
    elif bad := ungrounded(headline, pool):
        errors.append(f"Le titre cite {', '.join(f'« {b} »' for b in bad)}, absent des faits.")

    points: list[SummaryPoint] = []
    items = raw.get("points") if isinstance(raw.get("points"), list) else []
    for k, item in enumerate(items[: req.max_points], start=1):
        if not isinstance(item, dict) or not isinstance(item.get("text"), str) or not item["text"].strip():
            continue
        text = tidy(item["text"], POINT_MAX)
        refs = item.get("visuels") if isinstance(item.get("visuels"), list) else []
        ids = [req.visuals[i - 1].id for i in refs if isinstance(i, int) and 1 <= i <= len(req.visuals)]
        if bad := ungrounded(text, pool):
            errors.append(f"Le point {k} cite {', '.join(f'« {b} »' for b in bad)}, absent des faits.")
        points.append(SummaryPoint(text=text, visuals=list(dict.fromkeys(ids))))
    if not points:
        errors.append("Aucun point exploitable.")
    return Draft(headline, points, errors)


async def summarize(service: AIService, req: SummaryRequest) -> SummaryResponse:
    """Synthèse vérifiée : une relance au plus, puis retrait de ce qui reste invérifiable."""
    pool = allowed_numbers(req)
    system = f"{RULES}\nÉcris au plus {req.max_points} points."
    messages = [ChatMessage(role="user", content=f"Faits de la page :\n{facts_text(req)}")]
    schema = summary_schema(req)

    provider, raw = await service.chat_json(req.provider, messages, system, schema)
    draft = check(raw, req, pool)
    if draft.errors:
        retry = messages + [
            ChatMessage(role="assistant", content=json.dumps(raw, ensure_ascii=False)[:6000]),
            ChatMessage(
                role="user",
                content="Ta synthèse contient des erreurs :\n- "
                + "\n- ".join(draft.errors)
                + "\nRéécris-la en recopiant uniquement des chiffres présents dans les faits.",
            ),
        ]
        try:
            provider, raw2 = await service.chat_json(req.provider, retry, system, schema)
            second = check(raw2, req, pool)
            if len(second.errors) <= len(draft.errors):
                draft = second
        except AIProviderError:
            pass  # on garde la première version, nettoyée ci-dessous

    warnings: list[str] = []
    points: list[SummaryPoint] = []
    for p in draft.points:
        if bad := ungrounded(p.text, pool):
            warnings.append(f"Point écarté (chiffre non vérifiable : {', '.join(bad)}) : {p.text}")
        else:
            points.append(p)
    headline = draft.headline
    if not headline or ungrounded(headline, pool):
        if headline:
            warnings.append(f"Titre remplacé (chiffre non vérifiable) : {headline}")
        headline = f"Synthèse de la page « {req.page} »"
    if not points:
        raise AIProviderError(
            provider.name, "L'IA n'a produit aucun point vérifiable à partir des chiffres de la page.", 422
        )
    return SummaryResponse(
        headline=headline, points=points, provider=provider.name, model=provider.model, warnings=warnings
    )
