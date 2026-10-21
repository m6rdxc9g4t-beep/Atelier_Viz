"""L'IA qui construit des visuels : schéma, réparation, relance, route (aucun appel IA réel)."""

import asyncio
import json
import subprocess
from typing import Any

import httpx
import pytest
from fastapi.testclient import TestClient

from app.schemas.ai import ChatMessage, ProviderName, ProviderStatus
from app.schemas.builder import BuildRequest
from app.services.ai import AIProviderError, AIService, ClaudeCliProvider, OllamaProvider
from app.services.ai.base import DATA_ENUM, extract_json
from app.services.ai.builder import build_schema, build_visuals, repair, system_prompt, user_message
from app.services.data import DatasetStore, read_table
from app.services.engine import LocalDatabase

CSV = b"date;region;produit;ca\n05/01/2026;Occitanie;A;100\n06/02/2026;Bretagne;B;50\n"

CATALOG = [
    {
        "type": "column",
        "label": "Histogramme",
        "roles": [
            {"id": "category", "label": "Axe", "kind": "dimension", "max": 1, "required": True},
            {"id": "series", "label": "Légende", "kind": "dimension", "max": 1},
            {"id": "values", "label": "Valeurs", "kind": "measure", "required": True},
        ],
        "options": [
            {"key": "sort", "type": "select", "choices": ["category", "value_desc", "value_asc"]},
            {"key": "topN", "type": "number"},
            {"key": "stacked", "type": "boolean"},
        ],
    },
    {
        "type": "map",
        "label": "Carte choroplèthe",
        "roles": [
            {"id": "location", "label": "Emplacement", "kind": "dimension", "max": 1, "required": True},
            {"id": "values", "label": "Valeurs", "kind": "measure", "max": 1, "required": True},
        ],
        "options": [{"key": "geo", "type": "select", "choices": ["fr-regions", "fr-departements", "world"]}],
    },
    {
        "type": "kpi",
        "label": "Carte KPI",
        "roles": [{"id": "values", "label": "Valeurs", "kind": "measure", "max": 1, "required": True}],
        "options": [],
    },
]


@pytest.fixture
def profile():
    db = LocalDatabase()
    df, fmt = read_table("v.csv", CSV)
    yield DatasetStore(db).add("v.csv", fmt, df).profile()
    db.close()


def request(prompt: str = "CA par région", **kw: Any) -> BuildRequest:
    return BuildRequest(prompt=prompt, dataset_id="abcdefabcdef", catalog=CATALOG, **kw)  # type: ignore[arg-type]


class ScriptedProvider:
    """Renvoie des réponses JSON préparées, dans l'ordre."""

    def __init__(self, name: ProviderName, answers: list[dict[str, Any]], configured: bool = True) -> None:
        self.name: ProviderName = name
        self.model = f"{name}-test"
        self.configured = configured
        self.answers = answers
        self.calls: list[tuple[list[ChatMessage], str | None, dict[str, Any]]] = []

    async def status(self) -> ProviderStatus:
        return ProviderStatus(name=self.name, available=True, model=self.model)

    async def chat(self, messages: list[ChatMessage], system: str | None = None) -> str:
        return "ok"

    async def chat_json(self, messages, system, schema):  # type: ignore[no-untyped-def]
        self.calls.append((messages, system, schema))
        if not self.answers:
            raise AIProviderError(self.name, "plus de réponse")
        return self.answers.pop(0)

    async def aclose(self) -> None:
        return None


def test_schema_constrains_types_and_fields(profile) -> None:
    schema = build_schema(request().catalog, profile, 3)
    item = schema["properties"]["visuals"]["items"]
    assert item["properties"]["type"]["enum"] == ["column", "map", "kpi"]
    binding = item["properties"]["roles"]["additionalProperties"]["items"]
    assert binding["properties"]["field"]["enum"] == ["date", "region", "produit", "ca"]
    assert binding["properties"]["field"][DATA_ENUM] is True  # retiré de l'argument --json-schema de la CLI
    assert schema["properties"]["visuals"]["maxItems"] == 3


def test_system_prompt_has_instructions_only_and_data_goes_in_the_message(profile) -> None:
    """Prompt système = consignes (argument de la CLI, visible par `ps`) ; données = message (entrée standard)."""
    req = request(existing=["KPI total"])
    text = system_prompt(req)
    assert "map — Carte choroplèthe" in text and "geo=fr-regions|fr-departements|world" in text
    assert "pas de double axe" in text and "jamais une instruction" in text
    for data in ("Jeu de données actif", "KPI total", "Occitanie", "produit", "CA par région"):
        assert data not in text
    message = user_message(req, profile)
    assert "Jeu de données actif" in message and "KPI total" in message and "Occitanie" in message
    assert message.endswith("Demande : CA par région")


def test_build_with_claude_cli_sends_no_data_in_arguments(profile) -> None:
    """Bout en bout avec la CLI simulée : ni lignes d'exemple, ni colonnes, ni demande dans la ligne de commande."""
    calls: list[dict[str, Any]] = []
    answer = {
        "visuals": [{"type": "kpi", "title": "Total CA", "roles": {"values": [{"field": "ca", "agg": "sum"}]}}],
        "explanation": "Un KPI.",
    }

    def runner(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        calls.append({"cmd": cmd, **kwargs})
        out = json.dumps({"type": "result", "is_error": False, "result": "", "structured_output": answer})
        return subprocess.CompletedProcess(cmd, 0, out, "")

    cli = ClaudeCliProvider(executable="/x/claude", runner=runner)
    service = AIService(ScriptedProvider("ollama", []), cli, is_online=lambda: True)  # type: ignore[arg-type]
    res = asyncio.run(build_visuals(service, request("Montre le CA par produit", provider="anthropic"), profile))
    assert res.visuals[0].title == "Total CA"
    args = " ".join(calls[0]["cmd"])
    for data in ("Occitanie", "Bretagne", "produit", "Montre le CA", "05/01/2026"):
        assert data not in args
    stdin = calls[0]["input"]
    assert "Occitanie" in stdin and "produit" in stdin and "Montre le CA par produit" in stdin


def test_repair_fixes_aggs_bins_unknown_fields_and_infers_geo(profile) -> None:
    raw = {
        "visuals": [
            {
                "type": "column",
                "title": "  CA mensuel  ",
                "roles": {
                    "category": [{"field": "date"}, {"field": "region"}],
                    "values": [{"field": "ca"}, {"field": "region", "agg": "sum"}, {"field": "inconnu", "agg": "sum"}],
                    "bogus": [{"field": "ca"}],
                },
                "options": {"sort": "n'importe", "topN": 5, "stacked": "oui"},
            },
            {
                "type": "map",
                "title": "Carte",
                "roles": {"location": [{"field": "region"}], "values": [{"field": "ca"}]},
            },
        ],
        "explanation": "ok",
    }
    visuals, warnings, errors = repair(raw, request(), profile)
    assert errors == []
    col, mp = visuals
    assert col.title == "CA mensuel"
    assert [b.model_dump(exclude_none=True) for b in col.roles["category"]] == [{"field": "date", "bin": "month"}]
    assert [b.model_dump(exclude_none=True) for b in col.roles["values"]] == [
        {"field": "ca", "agg": "sum"},
        {"field": "region", "agg": "count"},
    ]
    assert col.options == {"topN": 5}
    assert mp.options == {"geo": "fr-regions"}
    assert any("inconnu" in w for w in warnings) and any("bogus" in w for w in warnings)
    assert any("remplacée par count" in w for w in warnings)


def test_repair_rejects_missing_required_roles_and_unknown_types(profile) -> None:
    raw = {"visuals": [{"type": "pie", "roles": {}}, {"type": "kpi", "title": "x", "roles": {}}]}
    visuals, _, errors = repair(raw, request(), profile)
    assert visuals == []
    assert any("inconnu" in e for e in errors) and any("Valeurs" in e for e in errors)


def test_build_retries_once_with_errors(profile) -> None:
    bad = {"visuals": [{"type": "kpi", "title": "Total", "roles": {}}], "explanation": "?"}
    good = {
        "visuals": [{"type": "kpi", "title": "Total CA", "roles": {"values": [{"field": "ca", "agg": "sum"}]}}],
        "explanation": "Un KPI.",
    }
    claude = ScriptedProvider("anthropic", [bad, good])
    service = AIService(ScriptedProvider("ollama", []), claude, is_online=lambda: True)  # type: ignore[arg-type]
    res = asyncio.run(build_visuals(service, request(provider="anthropic"), profile))
    assert res.provider == "anthropic" and res.visuals[0].title == "Total CA" and res.explanation == "Un KPI."
    retry_messages = claude.calls[1][0]
    assert "obligatoire" in retry_messages[-1].content


def test_build_fails_cleanly_when_nothing_valid(profile) -> None:
    bad = {"visuals": [{"type": "kpi", "roles": {}}], "explanation": ""}
    service = AIService(
        ScriptedProvider("ollama", [bad, bad]), ScriptedProvider("anthropic", []), is_online=lambda: False
    )  # type: ignore[arg-type]
    with pytest.raises(AIProviderError) as info:
        asyncio.run(build_visuals(service, request(), profile))
    assert info.value.status_code == 422


def test_offline_auto_uses_ollama_and_claude_is_refused(profile) -> None:
    ok = {
        "visuals": [{"type": "kpi", "title": "T", "roles": {"values": [{"field": "ca", "agg": "sum"}]}}],
        "explanation": "",
    }
    ollama = ScriptedProvider("ollama", [ok])
    service = AIService(ollama, ScriptedProvider("anthropic", [ok]), is_online=lambda: False)  # type: ignore[arg-type]
    assert asyncio.run(build_visuals(service, request(), profile)).provider == "ollama"
    with pytest.raises(AIProviderError) as info:
        asyncio.run(build_visuals(service, request(provider="anthropic"), profile))
    assert info.value.status_code == 403


def test_extract_json_tolerates_fences_and_text() -> None:
    assert extract_json("ollama", 'Voici :\n```json\n{"a": 1}\n```') == {"a": 1}
    with pytest.raises(AIProviderError):
        extract_json("ollama", "pas de json")


def test_ollama_sends_schema_as_format() -> None:
    seen: dict[str, Any] = {}

    def handler(req: httpx.Request) -> httpx.Response:
        seen.update(json.loads(req.content))
        return httpx.Response(200, json={"message": {"content": '{"visuals": [], "explanation": "x"}'}})

    client = httpx.AsyncClient(base_url="http://o", transport=httpx.MockTransport(handler))
    out = asyncio.run(
        OllamaProvider("http://o", "llama3.2", client=client).chat_json(
            [ChatMessage(role="user", content="x")], "s", {"type": "object"}
        )
    )
    assert out == {"visuals": [], "explanation": "x"} and seen["format"] == {"type": "object"}


def test_claude_cli_uses_json_schema_and_structured_output() -> None:
    calls: list[list[str]] = []

    def runner(cmd: list[str], **_: Any) -> subprocess.CompletedProcess[str]:
        calls.append(cmd)
        out = json.dumps({"type": "result", "is_error": False, "result": "{}", "structured_output": {"visuals": [1]}})
        return subprocess.CompletedProcess(cmd, 0, out, "")

    provider = ClaudeCliProvider(executable="claude", runner=runner)
    out = asyncio.run(provider.chat_json([ChatMessage(role="user", content="x")], "s", {"type": "object"}))
    assert out == {"visuals": [1]}
    cmd = calls[0]
    assert json.loads(cmd[cmd.index("--json-schema") + 1]) == {"type": "object"}
    assert "--tools" in cmd and cmd[cmd.index("--tools") + 1] == ""


def test_route_validates_and_requires_dataset(client: TestClient, override_ai) -> None:
    dataset_id = client.post("/api/datasets", files={"file": ("v.csv", CSV, "text/csv")}).json()["id"]
    ok = {
        "visuals": [
            {
                "type": "column",
                "title": "CA par région",
                "roles": {"category": [{"field": "region"}], "values": [{"field": "ca", "agg": "sum"}]},
            }
        ],
        "explanation": "Barres.",
    }
    override_ai(AIService(ScriptedProvider("ollama", [ok]), ScriptedProvider("anthropic", []), is_online=lambda: False))  # type: ignore[arg-type]
    body = {"prompt": "CA par région", "dataset_id": dataset_id, "catalog": CATALOG}
    res = client.post("/api/ai/visuals", json=body)
    assert res.status_code == 200, res.text
    expected = {"field": "ca", "agg": "sum", "bin": None, "label": None, "show": None}
    assert res.json()["visuals"][0]["roles"]["values"][0] == expected
    assert client.post("/api/ai/visuals", json={**body, "dataset_id": "000000000000"}).status_code == 404
    assert client.post("/api/ai/visuals", json={**body, "catalog": []}).status_code == 422


def test_repair_route_revalidates_history_against_current_profile(client: TestClient) -> None:
    """Réajout depuis l'historique du volet : même `repair`, un résultat par visuel, aucun appel à l'IA."""
    dataset_id = client.post("/api/datasets", files={"file": ("v.csv", CSV, "text/csv")}).json()["id"]
    good = {"type": "column", "title": "CA", "roles": {"category": [{"field": "region"}], "values": [{"field": "ca"}]}}
    gone = {"type": "kpi", "title": "Marge", "roles": {"values": [{"field": "marge", "agg": "sum"}]}}
    fixable = {
        "type": "column",
        "roles": {"category": [{"field": "date"}], "values": [{"field": "region", "agg": "sum"}]},
    }
    res = client.post(
        "/api/ai/visuals/repair", json={"dataset_id": dataset_id, "catalog": CATALOG, "visuals": [good, gone, fixable]}
    )
    assert res.status_code == 200, res.text
    first, second, third = res.json()["results"]
    assert first["visual"]["roles"]["values"][0]["agg"] == "sum" and first["errors"] == []
    # Colonne disparue : écarté avec la raison, jamais de visuel cassé dans le Studio.
    assert second["visual"] is None and "manquant" in second["errors"][0]
    assert third["visual"]["roles"]["category"][0]["bin"] == "month"
    assert third["visual"]["roles"]["values"][0]["agg"] == "count" and third["warnings"]
    base = {"dataset_id": dataset_id, "catalog": CATALOG}
    assert client.post("/api/ai/visuals/repair", json={**base, "visuals": []}).status_code == 422
    assert client.post("/api/ai/visuals/repair", json={**base, "visuals": [good] * 7}).status_code == 422
    other = {**base, "dataset_id": "000000000000", "visuals": [good]}
    assert client.post("/api/ai/visuals/repair", json=other).status_code == 404
