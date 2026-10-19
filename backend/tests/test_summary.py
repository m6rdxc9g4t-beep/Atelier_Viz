"""Résumé d'une page : lecture des nombres, vérification contre les faits, relance, route."""

import asyncio
from typing import Any

from fastapi.testclient import TestClient

from app.schemas.summary import SummaryRequest
from app.services.ai import AIProviderError, AIService
from app.services.ai.summary import allowed_numbers, check, facts_text, numbers, summarize, tidy, ungrounded
from tests.test_builder import ScriptedProvider

BODY: dict[str, Any] = {
    "report": "Ventes 2026",
    "page": "Vue d'ensemble",
    "filters": ["region : Occitanie, Bretagne"],
    "visuals": [
        {
            "id": "v1",
            "title": "CA total",
            "type": "kpi",
            "facts": ["Somme de ca : 4,4 M", "Cible : 4 M (écart +10,0 %)"],
        },
        {
            "id": "v2",
            "title": "CA par mois",
            "type": "line",
            "facts": ["Évolution de janv. 2026 à sept. 2026 : +48 % (382 k → 566 k)", "Maximum : mars 2026 — 640 k"],
        },
    ],
}


def req(**kw: Any) -> SummaryRequest:
    return SummaryRequest.model_validate({**BODY, **kw})


def service(*answers: dict[str, Any], online: bool = False) -> tuple[AIService, ScriptedProvider]:
    ollama = ScriptedProvider("ollama", list(answers))
    return AIService(ollama, ScriptedProvider("anthropic", []), is_online=lambda: online), ollama  # type: ignore[arg-type]


GOOD = {
    "headline": "4,4 M de chiffre d'affaires, +10,0 % au-dessus de la cible",
    "points": [
        {"text": "Le CA progresse de +48 % entre janvier et septembre (382 k → 566 k).", "visuels": [2]},
        {"text": "Mars 2026 est le meilleur mois avec 640 k.", "visuels": [2, 2, 9]},
    ],
}


def test_numbers_read_french_formats() -> None:
    got = {n.text: (n.value, n.percent) for n in numbers("4,4 M ; 974 k ; 22,4 % ; 1 234 567 ; 2 millions ; T1")}
    assert got == {
        "4,4 M": (4.4e6, False),
        "974 k": (974e3, False),
        "22,4 %": (22.4, True),
        "1 234 567": (1234567, False),
        "2 millions": (2e6, False),
    }


def test_grounding_accepts_rounding_counts_years_and_rejects_invented_numbers() -> None:
    pool = allowed_numbers(req())
    assert ungrounded("Environ 4,4 millions, soit 4 412 000 ; 3 mois en 2026 ; hausse de 48 %", pool) == []
    assert ungrounded("Une marge de 12 % et 7,5 M de commandes", pool) == ["12 %", "7,5 M"]
    # Un pourcentage ne valide pas un montant de même valeur.
    assert ungrounded("48 k", pool) == ["48 k"]


def test_check_maps_visual_numbers_to_ids_and_lists_errors() -> None:
    d = check(GOOD, req(), allowed_numbers(req()))
    assert d.errors == []
    assert d.points[1].visuals == ["v2"]  # doublons et numéros hors limites retirés
    bad = check({"headline": "", "points": [{"text": "Hausse de 75 %"}]}, req(), allowed_numbers(req()))
    assert len(bad.errors) == 2


def test_facts_text_lists_filters_and_numbered_visuals() -> None:
    text = facts_text(req())
    assert "Filtres actifs : region : Occitanie, Bretagne" in text
    assert "Visuel 2 — « CA par mois » (line)" in text and "- Maximum : mars 2026 — 640 k" in text


def test_summarize_retries_then_drops_unverifiable_points() -> None:
    first = {"headline": "CA de 5,2 M", "points": [{"text": "Hausse de 75 %"}]}
    second = {"headline": "CA de 4,4 M", "points": [GOOD["points"][0], {"text": "Marge de 31 %", "visuels": [1]}]}
    svc, ollama = service(first, second)
    res = asyncio.run(summarize(svc, req()))
    assert len(ollama.calls) == 2
    assert "« 5,2\u00a0M »" in ollama.calls[1][0][-1].content  # la relance liste les écarts
    assert res.headline == "CA de 4,4\u00a0M"
    assert [p.text for p in res.points] == [GOOD["points"][0]["text"].replace(" %", "\u00a0%").replace(" k", "\u00a0k")]
    assert res.warnings and "31\u00a0%" in res.warnings[0]
    assert res.provider == "ollama"


def test_summarize_replaces_bad_headline_and_fails_when_nothing_is_verifiable() -> None:
    svc, _ = service(
        {"headline": "Record de 9 M", "points": GOOD["points"]}, {"headline": "Record de 9 M", "points": GOOD["points"]}
    )
    res = asyncio.run(summarize(svc, req()))
    assert res.headline == "Synthèse de la page « Vue d'ensemble »"
    svc, _ = service({"headline": "x", "points": [{"text": "99 %"}]}, {"headline": "x", "points": [{"text": "98 %"}]})
    try:
        asyncio.run(summarize(svc, req()))
        raise AssertionError("une erreur 422 était attendue")
    except AIProviderError as exc:
        assert exc.status_code == 422


def test_claude_is_refused_offline() -> None:
    svc, _ = service(GOOD)
    try:
        asyncio.run(summarize(svc, req(provider="anthropic")))
        raise AssertionError("403 attendu")
    except AIProviderError as exc:
        assert exc.status_code == 403


def test_route(client: TestClient, override_ai) -> None:
    svc, _ = service(GOOD)
    override_ai(svc)
    res = client.post("/api/ai/summary", json=BODY)
    assert res.status_code == 200, res.text
    assert res.json()["points"][0]["visuals"] == ["v2"]
    assert client.post("/api/ai/summary", json={**BODY, "visuals": []}).status_code == 422


def test_numbers_read_the_frontend_formatting() -> None:
    """Espaces fines et insécables d'Intl fr-FR (« 1 234 567 », « 974 k », « 22 % »)."""
    got = [(n.value, n.percent) for n in numbers("1 234 567 ; 974 k ; 4,4 M ; +48 %")]
    assert got == [(1234567, False), (974e3, False), (4.4e6, False), (48, True)]


def test_tidy_keeps_units_with_their_number() -> None:
    assert tidy("  +48 %  et\n974 k ; 1\u202f234 ", 100) == "+48\u00a0% et 974\u00a0k ; 1\u202f234"
