"""Questions en langage naturel et explication d'un écart : réponse vérifiée contre les faits."""

import asyncio
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.schemas.summary import AnswerRequest
from app.services.ai import AIProviderError
from app.services.ai.answer import answer, facts_text
from tests.test_summary import service

BODY: dict[str, Any] = {
    "question": "Quelle région a le plus gros CA en 2026 ?",
    "filters": ["produit : Logiciel"],
    "visuals": [
        {
            "id": "ask",
            "title": "CA par région",
            "type": "bar",
            "facts": ["Total : 1,9 M", "1er : Occitanie — 415 k (21 % du total)", "2e : Auvergne-Rhône-Alpes — 407 k"],
        }
    ],
}


def req(**kw: Any) -> AnswerRequest:
    return AnswerRequest.model_validate({**BODY, **kw})


def test_answer_is_grounded() -> None:
    svc, ollama = service({"answer": "C'est l'Occitanie, avec 415 k (21 % du total). Suivent les 2 régions alpines."})
    res = asyncio.run(answer(svc, req()))
    assert res.answer.startswith("C'est l'Occitanie, avec 415 k (21 % du total).")
    assert res.warnings == [] and res.provider == "ollama"
    # Les faits partent dans la conversation (données), jamais dans le prompt système.
    messages, system, _ = ollama.calls[0]
    assert "415 k" in messages[0].content and "415 k" not in (system or "")


def test_answer_retries_then_drops_unverified_sentences() -> None:
    svc, ollama = service(
        {"answer": "L'Occitanie mène avec 500 k."},
        {"answer": "L'Occitanie mène avec 415 k. Elle croît de 12 % sur un an."},
    )
    res = asyncio.run(answer(svc, req()))
    assert len(ollama.calls) == 2 and "500\u00a0k" in ollama.calls[1][0][-1].content
    assert res.answer == "L'Occitanie mène avec 415 k."
    assert res.warnings and "12" in res.warnings[0]


def test_answer_without_any_verifiable_sentence_is_refused() -> None:
    svc, _ = service({"answer": "Environ 9 999 999."}, {"answer": "Toujours 9 999 999."})
    with pytest.raises(AIProviderError, match="aucune réponse vérifiable"):
        asyncio.run(answer(svc, req()))


def test_explain_kind_uses_its_own_rules() -> None:
    svc, ollama = service({"answer": "Le CA gagne 12 k entre février et mars, porté par Logiciel (+9 k)."})
    facts = ["Écart : +12 k (+8,1 %) de févr. 2026 à mars 2026", "produit = Logiciel : +9 k"]
    res = asyncio.run(
        answer(
            svc, req(kind="explain", question="Pourquoi mars 2026 ?", visuals=[{**BODY["visuals"][0], "facts": facts}])
        )
    )
    assert "Logiciel" in res.answer and "contributeurs" in (ollama.calls[0][1] or "")
    assert "Question : Pourquoi mars 2026 ?" in facts_text(req(question="Pourquoi mars 2026 ?"))


def test_route(client: TestClient, override_ai) -> None:
    svc, _ = service({"answer": "L'Occitanie, avec 415 k."})
    override_ai(svc)
    res = client.post("/api/ai/answer", json=BODY)
    assert res.status_code == 200, res.text
    assert res.json()["answer"] == "L'Occitanie, avec 415 k."
    assert client.post("/api/ai/answer", json={**BODY, "kind": "autre"}).status_code == 422
    assert client.post("/api/ai/answer", json={**BODY, "visuals": []}).status_code == 422
