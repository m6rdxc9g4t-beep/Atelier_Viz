"""ClaudeCliProvider testé avec un faux `subprocess.run` (la vraie CLI n'est jamais lancée)."""

import asyncio
import json
import subprocess
from typing import Any

import pytest

from app.api.deps import build_claude_provider
from app.core.config import Settings
from app.schemas.ai import ChatMessage
from app.services.ai import AIProviderError, AnthropicProvider, ClaudeCliProvider
from app.services.ai.claude_cli import format_conversation, parse_result


class FakeRunner:
    """Enregistre les appels et renvoie une sortie préparée."""

    def __init__(self, stdout: str = "", returncode: int = 0, stderr: str = "", exc: Exception | None = None):
        self.stdout, self.returncode, self.stderr, self.exc = stdout, returncode, stderr, exc
        self.calls: list[dict[str, Any]] = []

    def __call__(self, cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        self.calls.append({"cmd": cmd, **kwargs})
        if self.exc:
            raise self.exc
        return subprocess.CompletedProcess(cmd, self.returncode, self.stdout, self.stderr)


def result_json(text: str, is_error: bool = False) -> str:
    return json.dumps({"type": "result", "subtype": "success", "is_error": is_error, "result": text})


def provider(runner: FakeRunner) -> ClaudeCliProvider:
    return ClaudeCliProvider(executable="claude", model="sonnet", runner=runner)


MSG = [ChatMessage(role="user", content="Bonjour")]


def test_chat_returns_result_and_isolates_the_call(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ne-doit-pas-fuiter")
    runner = FakeRunner(stdout=result_json("Salut !"))
    answer = asyncio.run(provider(runner).chat(MSG, system="Sois bref"))

    assert answer == "Salut !"
    call = runner.calls[0]
    cmd = call["cmd"]
    assert cmd[:2] == ["claude", "-p"]
    for flag in ("--safe-mode", "--no-session-persistence", "--strict-mcp-config"):
        assert flag in cmd
    assert cmd[cmd.index("--tools") + 1] == ""
    assert cmd[cmd.index("--model") + 1] == "sonnet"
    assert cmd[cmd.index("--system-prompt") + 1] == "Sois bref"
    assert call["input"] == "Bonjour"
    assert "ANTHROPIC_API_KEY" not in call["env"]  # facturation via l'abonnement


def test_chat_surfaces_cli_error() -> None:
    runner = FakeRunner(stdout=result_json("Model not found", is_error=True), returncode=1)
    with pytest.raises(AIProviderError, match="Model not found"):
        asyncio.run(provider(runner).chat(MSG))


def test_chat_unreadable_output_suggests_update() -> None:
    runner = FakeRunner(stdout="", stderr="error: unknown option '--safe-mode'", returncode=1)
    with pytest.raises(AIProviderError, match="claude update"):
        asyncio.run(provider(runner).chat(MSG))


def test_chat_timeout_is_504() -> None:
    runner = FakeRunner(exc=subprocess.TimeoutExpired("claude", 1))
    with pytest.raises(AIProviderError) as info:
        asyncio.run(provider(runner).chat(MSG))
    assert info.value.status_code == 504


@pytest.mark.parametrize(
    ("auth", "available", "detail_part"),
    [
        ({"loggedIn": True, "authMethod": "claude.ai"}, True, None),
        ({"loggedIn": True, "authMethod": "api_key"}, True, "clé API"),
        ({"loggedIn": False, "authMethod": "none"}, False, "claude auth login"),
    ],
)
def test_status_reads_auth_status(auth: dict[str, object], available: bool, detail_part: str | None) -> None:
    runner = FakeRunner(stdout=json.dumps(auth))
    status = asyncio.run(provider(runner).status())
    assert runner.calls[0]["cmd"] == ["claude", "auth", "status"]
    assert status.available is available
    assert status.model == "sonnet (CLI)"
    if detail_part:
        assert detail_part in (status.detail or "")
    else:
        assert status.detail is None


def test_status_when_cli_missing() -> None:
    missing = ClaudeCliProvider(executable="claude-introuvable-xyz")
    assert missing.configured is False
    status = asyncio.run(missing.status())
    assert status.available is False
    assert "introuvable" in (status.detail or "")


def test_format_conversation_multi_turn() -> None:
    text = format_conversation(
        [
            ChatMessage(role="user", content="Q1"),
            ChatMessage(role="assistant", content="R1"),
            ChatMessage(role="user", content="Q2"),
        ]
    )
    assert "Utilisateur : Q1" in text and "Assistant : R1" in text and text.rstrip().endswith("préfixe.")


def test_parse_result_skips_noise_lines() -> None:
    assert parse_result("[claude-code:warning] x\n" + result_json("ok")) == json.loads(result_json("ok"))
    assert parse_result("pas du json") is None


def test_claude_mode_selects_provider() -> None:
    cli = build_claude_provider(Settings(claude_mode="cli", _env_file=None))  # type: ignore[call-arg]
    api = build_claude_provider(Settings(claude_mode="api", _env_file=None))  # type: ignore[call-arg]
    assert isinstance(cli, ClaudeCliProvider)
    assert isinstance(api, AnthropicProvider)
