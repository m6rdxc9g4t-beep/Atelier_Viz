"""L'IA qui construit : une phrase → des visuels prêts à placer dans le Studio.

Garde-fous (dans l'ordre) :
1. schéma JSON contraint (types de visuels du catalogue, champs du jeu de données en énumération) ;
2. validation + réparation : rôles, champs, agrégations, périodes, maximum par rôle, options ;
3. si un visuel reste invalide : une seconde demande à l'IA avec la liste des erreurs ;
4. ce qui ne peut pas être réparé est écarté (jamais de visuel cassé dans le Studio).
"""

import json
from typing import Any

from pydantic import ValidationError

from app.schemas.ai import ChatMessage
from app.schemas.builder import BuildRequest, BuildResponse, OptionSpec, ProposedVisual, VisualTypeSpec
from app.schemas.dataset import ColumnType, DatasetProfile
from app.schemas.query import Agg, DateBin
from app.schemas.report import FieldBinding
from app.services.ai.base import AIProviderError
from app.services.ai.service import AIService
from app.services.data.context import dataset_context

AGGS: list[Agg] = ["sum", "avg", "median", "min", "max", "count", "count_distinct"]
BINS: list[DateBin] = ["year", "quarter", "month", "week", "day"]
AGGS_BY_TYPE: dict[ColumnType, set[Agg]] = {
    "number": set(AGGS),
    "boolean": {"sum", "avg", "count"},
    "date": {"min", "max", "count", "count_distinct"},
    "string": {"count", "count_distinct", "min", "max"},
}
GEO_HINTS = {
    "region": "fr-regions",
    "departement": "fr-departements",
    "dept": "fr-departements",
    "pays": "world",
    "country": "world",
}

RULES = """Règles de choix (bonnes pratiques de visualisation) :
- évolution dans le temps → line, area ou column, avec la date regroupée (bin month, quarter ou year) ;
- comparaison de catégories → bar (libellés longs ou plus de 8 catégories) ou column (peu de catégories courtes) ;
- part d'un tout → donut ou pie seulement si 6 catégories ou moins, sinon bar ;
- champ géographique (région, département, pays) → map avec l'option geo adaptée ;
- un seul chiffre clé → kpi ; une valeur par rapport à une cible → gauge ;
- relation entre deux mesures → scatter ; détail ligne à ligne → table ; croisement de deux dimensions → matrix ;
- « top N » → option topN et sort = value_desc ;
- jamais deux mesures d'unités différentes sur le même graphique (pas de double axe) : fais deux visuels ;
- 8 séries au maximum dans une légende ;
- montants ou totaux souvent supérieurs à 10 000 → option compact = true (12,5 k ; 4,4 M).
Contraintes techniques :
- n'utilise QUE les champs listés, avec leur nom exact ;
- une liaison dans un rôle « mesure » a toujours un agg compatible avec le type du champ
  (sum/avg/median uniquement sur des nombres ; count fonctionne partout) ;
- une liaison dans un rôle « dimension » n'a jamais d'agg ; une date en dimension a un bin ;
- remplis tous les rôles obligatoires ; respecte le nombre maximal de champs par rôle ;
- title : court, en français, décrit ce que montre le visuel (ex. « Chiffre d'affaires par région »).
- explanation : 1 à 3 phrases en français qui justifient les choix."""


def catalog_text(catalog: list[VisualTypeSpec]) -> str:
    lines = []
    for spec in catalog:
        roles = "; ".join(
            f"{r.id} ({r.label}, {'mesure' if r.kind == 'measure' else 'dimension'}"
            f"{', obligatoire' if r.required else ''}{f', {r.max} max' if r.max else ''}"
            f"{', types ' + '/'.join(r.types) if r.types else ''})"
            for r in spec.roles
        )
        opts = ", ".join(
            f"{o.key}{'=' + '|'.join(o.choices) if o.choices else ' (' + o.type + ')'}" for o in spec.options
        )
        lines.append(f"- {spec.type} — {spec.label} : rôles {roles}" + (f" ; options {opts}" if opts else ""))
    return "\n".join(lines)


def build_schema(catalog: list[VisualTypeSpec], profile: DatasetProfile, max_visuals: int) -> dict[str, Any]:
    binding = {
        "type": "object",
        "properties": {
            "field": {"type": "string", "enum": [c.name for c in profile.columns]},
            "agg": {"type": "string", "enum": AGGS},
            "bin": {"type": "string", "enum": BINS},
        },
        "required": ["field"],
    }
    visual = {
        "type": "object",
        "properties": {
            "type": {"type": "string", "enum": [s.type for s in catalog]},
            "title": {"type": "string"},
            "roles": {"type": "object", "additionalProperties": {"type": "array", "items": binding}},
            "options": {"type": "object"},
        },
        "required": ["type", "title", "roles"],
    }
    return {
        "type": "object",
        "properties": {
            "visuals": {"type": "array", "minItems": 1, "maxItems": max_visuals, "items": visual},
            "explanation": {"type": "string"},
        },
        "required": ["visuals", "explanation"],
    }


def system_prompt(req: BuildRequest, profile: DatasetProfile) -> str:
    existing = f"\nVisuels déjà présents sur la page : {', '.join(req.existing)}." if req.existing else ""
    return (
        "Tu es l'assistant de création de visuels d'un outil de BI (équivalent de Power BI). "
        f"Propose entre 1 et {req.max_visuals} visuels qui répondent à la demande de l'utilisateur, "
        "et uniquement des visuels utiles (souvent un seul suffit).\n\n"
        f"Types de visuels disponibles :\n{catalog_text(req.catalog)}\n\n{RULES}\n\n"
        f"{dataset_context(profile)}{existing}"
    )


def _clean_option(spec: OptionSpec, value: Any) -> Any:
    if spec.type == "boolean":
        return value if isinstance(value, bool) else None
    if spec.type == "number":
        return value if isinstance(value, int | float) and not isinstance(value, bool) else None
    if spec.type == "select":
        return value if isinstance(value, str) and (not spec.choices or value in spec.choices) else None
    return value[:300] if isinstance(value, str) else None


def repair(
    raw: dict[str, Any], req: BuildRequest, profile: DatasetProfile
) -> tuple[list[ProposedVisual], list[str], list[str]]:
    """Valide et corrige la proposition. Retourne (visuels valides, corrections, erreurs bloquantes)."""
    specs = {s.type: s for s in req.catalog}
    columns = {c.name: c for c in profile.columns}
    visuals: list[ProposedVisual] = []
    warnings: list[str] = []
    errors: list[str] = []
    items = raw.get("visuals")
    if not isinstance(items, list) or not items:
        return [], [], ["« visuals » doit être une liste non vide."]

    for n, item in enumerate(items[: req.max_visuals], start=1):
        if not isinstance(item, dict):
            errors.append(f"Visuel {n} : objet attendu.")
            continue
        spec = specs.get(item.get("type"))  # type: ignore[arg-type]
        if spec is None:
            errors.append(f"Visuel {n} : type « {item.get('type')} » inconnu.")
            continue
        label = f"Visuel {n} ({spec.label})"
        roles_in = item.get("roles") if isinstance(item.get("roles"), dict) else {}
        roles_out: dict[str, list[FieldBinding]] = {}
        for role in spec.roles:
            out: list[FieldBinding] = []
            for b in roles_in.get(role.id) or []:
                if not isinstance(b, dict) or b.get("field") not in columns:
                    warnings.append(
                        f"{label} : champ inconnu « {b.get('field') if isinstance(b, dict) else b} » ignoré."
                    )
                    continue
                col = columns[b["field"]]
                if role.types and col.type not in role.types:
                    warnings.append(f"{label} : « {col.name} » ne convient pas au rôle {role.label}.")
                    continue
                if any(x.field == col.name for x in out):
                    continue
                if role.kind == "measure":
                    agg = b.get("agg")
                    allowed = AGGS_BY_TYPE[col.type]
                    if agg not in allowed:
                        fixed: Agg = "sum" if col.type in ("number", "boolean") and agg is None else "count"
                        if agg is not None:
                            warnings.append(
                                f"{label} : agrégation « {agg} » impossible sur « {col.name} », remplacée par {fixed}."
                            )
                        agg = fixed
                    out.append(FieldBinding(field=col.name, agg=agg))
                else:
                    bin_ = b.get("bin") if col.type == "date" else None
                    if col.type == "date" and bin_ not in BINS:
                        bin_ = "month"
                    out.append(FieldBinding(field=col.name, bin=bin_))
            if role.max and len(out) > role.max:
                out = out[: role.max]
            if out:
                roles_out[role.id] = out
        unknown = set(roles_in) - {r.id for r in spec.roles}
        if unknown:
            warnings.append(f"{label} : rôle(s) {', '.join(sorted(unknown))} ignoré(s).")
        missing = [r.label for r in spec.roles if r.required and r.id not in roles_out]
        if missing:
            errors.append(f"{label} : rôle(s) obligatoire(s) manquant(s) : {', '.join(missing)}.")
            continue

        options: dict[str, Any] = {}
        raw_opts = item.get("options") if isinstance(item.get("options"), dict) else {}
        for opt in spec.options:
            if opt.key in raw_opts:
                value = _clean_option(opt, raw_opts[opt.key])
                if value is not None:
                    options[opt.key] = value
        if spec.type == "map" and "geo" not in options:
            loc = roles_out.get("location", [None])[0]
            hint = next((v for k, v in GEO_HINTS.items() if loc and k in loc.field.lower()), None)
            if hint:
                options["geo"] = hint

        title = item.get("title")
        try:
            visuals.append(
                ProposedVisual(
                    type=spec.type,
                    title=title.strip()[:120] if isinstance(title, str) and title.strip() else None,
                    roles=roles_out,
                    options=options,
                )
            )
        except ValidationError as exc:
            errors.append(f"{label} : {exc.errors()[0]['msg']}")
    return visuals, warnings, errors


async def build_visuals(service: AIService, req: BuildRequest, profile: DatasetProfile) -> BuildResponse:
    """Interroge l'IA (une relance au plus si des visuels sont invalides) et retourne des visuels sûrs."""
    schema = build_schema(req.catalog, profile, req.max_visuals)
    system = system_prompt(req, profile)
    messages = [ChatMessage(role="user", content=req.prompt)]

    provider, raw = await service.chat_json(req.provider, "complex", messages, system, schema)
    visuals, warnings, errors = repair(raw, req, profile)

    if errors:
        retry = messages + [
            ChatMessage(role="assistant", content=json.dumps(raw, ensure_ascii=False)[:6000]),
            ChatMessage(
                role="user",
                content="Ta proposition contient des erreurs :\n- "
                + "\n- ".join(errors)
                + "\nCorrige-les et renvoie le JSON complet.",
            ),
        ]
        try:
            provider, raw2 = await service.chat_json(req.provider, "complex", retry, system, schema)
            visuals2, warnings2, errors2 = repair(raw2, req, profile)
            if len(visuals2) >= len(visuals):
                raw, visuals, warnings, errors = raw2, visuals2, warnings2, errors2
        except AIProviderError:
            pass  # on garde la première proposition (partielle)

    if not visuals:
        detail = " ".join(errors) or "aucun visuel exploitable."
        raise AIProviderError(provider.name, f"L'IA n'a pas produit de visuel valide : {detail}", 422)

    explanation = raw.get("explanation")
    return BuildResponse(
        visuals=visuals,
        explanation=explanation.strip() if isinstance(explanation, str) else "",
        provider=provider.name,
        model=provider.model,
        warnings=warnings + [f"Écarté — {e}" for e in errors],
    )
