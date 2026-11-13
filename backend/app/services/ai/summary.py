"""Résumé d'une page par l'IA, vérifié chiffre par chiffre.

1. Le frontend envoie des faits calculés (« Total : 4,4 M », « 1er : Occitanie — 974 k (22 % du total) ») et une
   lecture calculée de la page (une ouverture, quelques constats rédigés sans IA).
2. L'IA rédige une phrase d'ouverture et quelques points — une lecture, pas la liste des cartes —, en ne recopiant
   que ces chiffres (sortie JSON contrainte).
3. Chaque nombre du texte est comparé aux faits (à la précision écrite près, avec le même signe). Seuls restent
   libres un dénombrement (« les 3 premiers ») et une année (« en 2026 ») : jamais un montant, une multiplication
   ni une durée. Un chiffre introuvable, ou un point qui recopie un fait tel quel, déclenche une relance avec la
   liste des écarts ; ce qui reste est écarté.
4. Repli : un point écarté est remplacé par un constat de la lecture calculée ; si le modèle échoue ou ne donne
   rien d'exploitable, toute la synthèse vient de cette lecture (`local`). Sans lecture calculée (page où rien ne
   se compare), des points recopiés mais exacts sont gardés plutôt que de rendre une erreur.
"""

import json
import re
from dataclasses import dataclass
from typing import Any

from app.schemas.ai import ChatMessage, ProviderName
from app.schemas.summary import SummaryPoint, SummaryRequest, SummaryResponse
from app.services.ai.base import AIProviderError
from app.services.ai.service import AIService
from app.services.data.context import DATA_RULE, data_block

RULES = (
    """Tu es analyste. Tu écris la lecture d'une page de rapport pour un lecteur pressé, en français simple.

Ce qu'on attend :
- "headline" : UNE phrase d'ouverture (140 caractères au plus) qui dit ce qu'il faut retenir. Pas le titre de la page.
- "points" : du plus important au moins important, une phrase courte chacun. Cherche :
  ce qui ressort (le plus gros, le plus haut, la part du premier) ;
  ce qui évolue (hausse ou baisse, du début à la fin) ;
  ce qui mérite l'attention (un écart, une concentration, le rapport entre deux mesures).
- Chaque point compare, situe ou relie. Ne recopie jamais une carte (« Recettes : 13 k € » n'est pas un point).
- "visuels" : numéros des visuels d'où vient le point.
- Appuie-toi d'abord sur la « Lecture calculée » : reformule ses constats, regroupe ceux qui vont ensemble.

Règles sur les chiffres :
- utilise UNIQUEMENT les nombres fournis ; recopie chacun exactement comme il est écrit (unité, %, signe) ;
- ne calcule aucun nouveau chiffre (pas de somme, d'écart ni de pourcentage de ton cru) ;
- n'invente ni cause, ni contexte extérieur, ni prévision : décris des constats ;
- phrases courtes, mots courants, sans Markdown ni emoji.

Exemple (autres données : ne reprends pas ses chiffres).
Faits : « Visites : 12 k » ; « Commandes rapportées à Visites : 2,5 % » ;
« Début : janv. — 1,5 k ; fin : juin — 2,4 k » ; « Évolution du début à la fin : +60 % ».
Réponse : {"headline": "Les visites montent nettement, mais peu deviennent des commandes.",
"points": [{"text": "Les visites passent de 1,5 k en janvier à 2,4 k en juin, soit +60 %.", "visuels": [2]},
{"text": "Seules 2,5 % des visites donnent une commande.", "visuels": [1, 3]}]}
"""
    + DATA_RULE
)

HEADLINE_MAX = 200
POINT_MAX = 300

NUMBER = re.compile(
    r"(?<![\w,.])([+\-−]?)(\d{1,3}(?:[   ]\d{3})+|\d+)(?:[.,](\d+))?"
    r"[   ]?(%|Md|mds?|milliards?|M|millions?|k|K|milliers?)?(?!\w)",
)
# Unités en minuscules : « M » devient « m » (le motif n'accepte que la majuscule, pas de confusion avec « mètre »).
UNITS = {"k": 1e3, "millier": 1e3, "milliers": 1e3, "m": 1e6, "million": 1e6, "millions": 1e6}
BILLIONS = {"md", "mds", "milliard", "milliards"}


# Ce qui suit un nombre et en fait un montant ou une grandeur, pas une année ni un dénombrement.
_CURRENCY_AFTER = re.compile(r"[\s\u00a0\u202f]*(?:[€$£]|(?:euros?|eur|dollars?|usd|livres?)\b)", re.IGNORECASE)
# Durée : « en 3 mois » se vérifie comme un chiffre (les faits donnent le nombre de périodes).
_DURATION_AFTER = re.compile(
    r"[\s\u00a0\u202f]*(?:mois|ans?|années?|semaines?|jours?|trimestres?|semestres?|heures?|périodes?)\b", re.IGNORECASE
)
# Multiplication : « multiplié par 9 », « divisé par 2 », « 3 fois plus », « x 4 ».
_FACTOR_BEFORE = re.compile(r"(?:\bpar|\bx|×)[\s\u00a0\u202f]*$", re.IGNORECASE)
_FACTOR_AFTER = re.compile(r"[\s\u00a0\u202f]*(?:fois\b|[x×][\s\u00a0\u202f]*\d)", re.IGNORECASE)
# Mots qui disent qu'un montant est négatif sans l'écrire avec son signe (« un déficit de 1,2 k € »).
_NEGATIVE_WORDS = re.compile(
    r"baiss|recul|défici|négati|negati|perte|perd|moins|diminu|chut|repli|découvert|dessous|défavorable|retard|"
    r"manqu|dette|débit|dépens|sorti|rouge|réduction|réduit|inférieur",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class Number:
    """Nombre lu dans un texte : valeur, demi-unité du dernier chiffre écrit, pourcentage ou non."""

    text: str
    value: float
    precision: float
    percent: bool
    bare_integer: bool
    # Signe écrit devant le nombre : « + », « - » ou rien (la valeur, elle, est toujours positive).
    sign: str = ""
    # Entier libre : dénombrement (« les 3 premiers ») ou année (« en 2026 ») — admis sans figurer dans les faits.
    free: bool = False
    # Le texte dit par un mot que le montant est négatif (« baisse », « déficit ») : le signe peut manquer.
    negative_context: bool = False


def _free(whole: str, value: float, before: str, after: str) -> bool:
    """Entier sans décimale ni unité qui n'a pas à figurer dans les faits : dénombrement ou année.

    Jamais un montant (devise derrière), une multiplication (« par 9 », « 3 fois ») ni une durée (« en 3 mois ») ;
    une année s'écrit en 4 chiffres, sans séparateur de milliers (« 2 050 » est un montant).
    """
    if _CURRENCY_AFTER.match(after):
        return False
    if value <= 10:
        return not (_FACTOR_BEFORE.search(before) or _FACTOR_AFTER.match(after) or _DURATION_AFTER.match(after))
    return 1900 <= value <= 2100 and re.fullmatch(r"\d{4}", whole) is not None


def numbers(text: str) -> list[Number]:
    """Extrait les nombres écrits à la française (« 1 234,5 », « 4,4 M », « +48 % », « 2 millions »)."""
    found: list[Number] = []
    negative_context = _NEGATIVE_WORDS.search(text) is not None
    for m in NUMBER.finditer(text):
        sign, whole, frac, unit = m.groups()
        digits = re.sub(r"\D", "", whole)
        value = float(f"{digits}.{frac}" if frac else digits)
        u = (unit or "").lower()
        scale = 1e9 if u in BILLIONS else UNITS.get(u, 1.0)
        precision = 0.5 * 10 ** (-len(frac or "")) * scale
        bare = not frac and not unit
        found.append(
            Number(
                text=m.group(0).strip(),
                value=value * scale,
                precision=precision,
                percent=unit == "%",
                bare_integer=bare,
                sign="-" if sign in ("-", "−") else sign,
                free=bare
                and not sign
                and _free(whole, value, text[max(0, m.start() - 12) : m.start()], text[m.end() :]),
                negative_context=negative_context,
            )
        )
    return found


def allowed_numbers(req: SummaryRequest) -> list[Number]:
    texts = [req.report, req.page, *req.filters]
    for v in req.visuals:
        texts.append(v.title)
        texts.extend(v.facts)
    if req.reading:
        # La lecture calculée porte des chiffres de la page entière (rapport entre deux cartes) : des faits aussi.
        texts.extend([req.reading.headline, req.reading.period or "", *(p.text for p in req.reading.points)])
    return [n for t in texts for n in numbers(t)]


def _same_sign(n: Number, fact: Number) -> bool:
    """Le signe écrit concorde-t-il avec celui du fait ?

    Un fait négatif (« -1,2 k € ») se cite avec son signe, ou sans lui si la phrase dit la baisse ou le déficit ;
    jamais avec un « + ». Un fait positif ne se cite pas avec un « - ».
    """
    if fact.sign == "-":
        return n.sign == "-" or (n.sign == "" and n.negative_context)
    return n.sign != "-"


def grounded(n: Number, pool: list[Number]) -> bool:
    """Le nombre figure-t-il dans les faits (à la précision écrite près, avec le même signe) ?"""
    if n.free:
        return True  # dénombrements (« les 3 premiers ») et années
    for f in pool:
        if f.percent != n.percent:
            continue
        tolerance = max(n.precision, f.precision) + 1e-9 * max(abs(n.value), abs(f.value), 1)
        if abs(n.value - f.value) <= tolerance and _same_sign(n, f):
            return True
    return False


def ungrounded(text: str, pool: list[Number]) -> list[str]:
    return [n.text for n in numbers(text) if not grounded(n, pool)]


def _plain(text: str) -> str:
    """Texte réduit à ses mots et à ses chiffres, pour reconnaître une recopie."""
    return re.sub(r"[^0-9a-zà-ÿ%€]+", " ", text.lower()).strip()


_CARD_REST = re.compile(r"[\s€$£.\u00a0\u202f]+")


def recopied(text: str, req: SummaryRequest) -> bool:
    """Le point n'est-il qu'une carte recopiée (« Recettes : 13 k € ») ou un fait repris tel quel ?"""
    _label, sep, value = text.partition(":")
    if sep and NUMBER.search(value) and not _CARD_REST.sub("", NUMBER.sub("", value)):
        return True
    plain = _plain(text)
    return any(plain == _plain(f) for v in req.visuals for f in v.facts)


def facts_text(req: SummaryRequest) -> str:
    lines = [f"Rapport : {req.report}", f"Page : {req.page}"]
    if req.reading and req.reading.period:
        lines.append(f"Période couverte : {req.reading.period}")
    lines.append(
        f"Filtres actifs : {' ; '.join(req.filters)}" if req.filters else "Filtres actifs : aucun (toutes les données)"
    )
    if req.reading:
        number = {v.id: i for i, v in enumerate(req.visuals, start=1)}
        lines.append("\nLecture calculée (constats sûrs, à reformuler et à relier entre eux) :")
        for p in req.reading.points:
            refs = [str(number[i]) for i in p.visuals if i in number]
            where = f"[visuel{'s' if len(refs) > 1 else ''} {', '.join(refs)}] " if refs else ""
            lines.append(f"- {where}{p.text}")
        lines.append("\nDétail par visuel :")
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
        elif recopied(text, req):
            errors.append(
                f"Le point {k} recopie un chiffre tel quel : écris une phrase qui compare ou décrit une évolution."
            )
        points.append(SummaryPoint(text=text, visuals=list(dict.fromkeys(ids))))
    if not points:
        errors.append("Aucun point exploitable.")
    return Draft(headline, points, errors)


def local_points(req: SummaryRequest, limit: int, covered: set[str] | None = None) -> list[SummaryPoint]:
    """Constats de la lecture calculée, dans l'ordre (du plus lourd au plus léger).

    `covered` : visuels dont la synthèse parle déjà ; un constat qui ne concerne qu'eux est alors passé.
    """
    if not req.reading or limit <= 0:
        return []
    known = {v.id for v in req.visuals}
    seen = set(covered) if covered is not None else None
    out: list[SummaryPoint] = []
    for p in req.reading.points:
        ids = [i for i in dict.fromkeys(p.visuals) if i in known]
        if seen is not None and ids and all(i in seen for i in ids):
            continue
        out.append(SummaryPoint(text=tidy(p.text, POINT_MAX), visuals=ids, local=True))
        if seen is not None:
            seen.update(ids)
        if len(out) >= limit:
            break
    return out


def local_summary(req: SummaryRequest, provider: ProviderName, model: str, reason: str) -> SummaryResponse | None:
    """Synthèse entièrement tirée de la lecture calculée (aucune phrase du modèle) ; None si elle manque."""
    points = local_points(req, req.max_points)
    if not req.reading or not points:
        return None
    return SummaryResponse(
        headline=tidy(req.reading.headline, HEADLINE_MAX),
        points=points,
        provider=provider,
        model=model,
        warnings=[reason],
        local=True,
    )


PROVIDER_LABELS: dict[str, str] = {"ollama": "Ollama", "anthropic": "Claude"}


async def summarize(service: AIService, req: SummaryRequest) -> SummaryResponse:
    """Synthèse vérifiée : une relance au plus, puis retrait de ce qui reste invérifiable ou recopié.

    Ce qui est retiré est remplacé par la lecture calculée ; si le modèle échoue, elle fait toute la synthèse.
    Un refus de principe (Claude hors ligne, 403) reste une erreur : rien n'est rédigé à la place du moteur choisi.
    """
    pool = allowed_numbers(req)
    system = f"{RULES}\nÉcris au plus {req.max_points} points."
    # Les faits (titres, filtres, chiffres) sont des données : dans la conversation, jamais dans le prompt système.
    messages = [ChatMessage(role="user", content=f"Faits de la page :\n{data_block(facts_text(req))}")]
    schema = summary_schema(req)

    try:
        provider, raw = await service.chat_json(req.provider, messages, system, schema)
    except AIProviderError as exc:
        label = PROVIDER_LABELS.get(exc.provider, exc.provider)
        reason = f"{label} n'a pas répondu ({exc.message}) : lecture calculée sur cette machine, sans IA."
        fallback = None if exc.status_code == 403 else local_summary(req, exc.provider, "", reason)
        if fallback is None:
            raise
        return fallback
    draft = check(raw, req, pool)
    if draft.errors:
        retry = messages + [
            ChatMessage(role="assistant", content=json.dumps(raw, ensure_ascii=False)[:6000]),
            ChatMessage(
                role="user",
                content="Ta synthèse contient des erreurs :\n- "
                + "\n- ".join(draft.errors)
                + "\nRéécris-la : uniquement des chiffres présents dans les faits, et des phrases qui comparent ou "
                "situent au lieu de recopier une carte.",
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
    copies: list[SummaryPoint] = []
    for p in draft.points:
        if bad := ungrounded(p.text, pool):
            warnings.append(f"Point écarté (chiffre non vérifiable : {', '.join(bad)}) : {p.text}")
        elif recopied(p.text, req):
            copies.append(p)
        else:
            points.append(p)
    label = PROVIDER_LABELS.get(provider.name, provider.name)
    if not points:
        recopy = [f"Point écarté (simple recopie d'un chiffre de la page) : {p.text}" for p in copies]
        reason = (
            f"{label} n'a donné aucune phrase vérifiable ({len(warnings) + len(copies)} écartée(s)) : "
            "lecture calculée sur cette machine, sans IA."
        )
        fallback = local_summary(req, provider.name, provider.model, reason)
        if fallback is not None:
            fallback.warnings.extend(warnings + recopy)
            return fallback
        if not copies:
            raise AIProviderError(
                provider.name, "L'IA n'a produit aucun point vérifiable à partir des chiffres de la page.", 422
            )
        # Aucune lecture calculée pour prendre la place (page sans rien à comparer) : des chiffres recopiés mais
        # exacts valent mieux qu'une erreur. Seuls les chiffres invérifiables restent écartés.
        points = copies
        warnings.insert(
            0, "Rien à comparer sur cette page : ses chiffres sont repris tels quels, sans phrase qui les relie."
        )
    else:
        warnings.extend(f"Point écarté (simple recopie d'un chiffre de la page) : {p.text}" for p in copies)
    # Chaque phrase écartée laisse sa place à un constat calculé, sur un visuel dont l'IA n'a pas déjà parlé.
    missing = min(len(warnings), req.max_points - len(points))
    points.extend(local_points(req, missing, {i for p in points for i in p.visuals}))
    headline = draft.headline
    if not headline or ungrounded(headline, pool):
        if headline:
            warnings.append(f"Ouverture remplacée (chiffre non vérifiable) : {headline}")
        headline = tidy(req.reading.headline, HEADLINE_MAX) if req.reading else f"Synthèse de la page « {req.page} »"
    return SummaryResponse(
        headline=headline, points=points, provider=provider.name, model=provider.model, warnings=warnings
    )
