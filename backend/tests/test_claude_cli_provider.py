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
    assert call["env"]["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] == "1"  # pas de télémétrie


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
    # Recherche simulée : la machine de test peut avoir une vraie CLI dans le PATH ou ~/.local/bin.
    missing = ClaudeCliProvider(executable="claude-introuvable-xyz", finder=lambda: None)
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


# --- Recherche de l'exécutable, cache d'état, version, modèle choisi (docs/SUITE.md §5) ---


def test_find_claude_cli_order(tmp_path) -> None:
    """CLAUDE_CLI, puis l'exécutable configuré, puis le PATH, puis les dossiers d'installation."""
    from app.services.ai.claude_cli import FALLBACK_DIRS, find_claude_cli

    assert FALLBACK_DIRS == ("~/.local/bin", "/opt/homebrew/bin", "/usr/local/bin")
    seen: list[str] = []

    def which(name: str) -> str | None:
        seen.append(name)
        return {"/opt/claude-env": "/opt/claude-env", "claude": "/usr/bin/claude"}.get(name)

    env = {"CLAUDE_CLI": "/opt/claude-env"}
    assert find_claude_cli("claude", env=env, which=which, fallback_dirs=()) == "/opt/claude-env"
    seen.clear()
    assert find_claude_cli("/introuvable/claude", env={}, which=which, fallback_dirs=()) == "/usr/bin/claude"
    assert seen == ["/introuvable/claude", "claude"]


def test_find_claude_cli_falls_back_to_install_dirs(tmp_path) -> None:
    """Application lancée depuis le Finder : PATH minimal, la CLI est dans ~/.local/bin ou Homebrew."""
    from app.services.ai.claude_cli import find_claude_cli

    empty, local, brew = tmp_path / "vide", tmp_path / "local-bin", tmp_path / "homebrew-bin"
    for folder in (empty, local, brew):
        folder.mkdir()
    (local / "claude").write_text("#!/bin/sh\n")  # pas exécutable : ignoré
    exe = brew / "claude"
    exe.write_text("#!/bin/sh\n")
    exe.chmod(0o755)
    dirs = (str(empty), str(local), str(brew))
    assert find_claude_cli("claude", env={}, which=lambda _: None, fallback_dirs=dirs) == str(exe)
    assert find_claude_cli("claude", env={}, which=lambda _: None, fallback_dirs=dirs[:2]) is None


def test_claude_cli_env_variable_is_read_by_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CLAUDE_CLI", "/Users/moi/.local/bin/claude")
    assert Settings(_env_file=None).claude_cli_path == "/Users/moi/.local/bin/claude"  # type: ignore[call-arg]
    monkeypatch.delenv("CLAUDE_CLI")
    monkeypatch.setenv("CLAUDE_CLI_PATH", "/opt/homebrew/bin/claude")
    assert Settings(_env_file=None).claude_cli_path == "/opt/homebrew/bin/claude"  # type: ignore[call-arg]
    assert Settings(claude_cli_path="x", _env_file=None).claude_cli_path == "x"  # type: ignore[call-arg]


class AuthRunner(FakeRunner):
    """`claude --version` puis `claude auth status`."""

    def __call__(self, cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        self.calls.append({"cmd": cmd, **kwargs})
        if cmd[1:] == ["--version"]:
            return subprocess.CompletedProcess(cmd, 0, "2.1.303 (Claude Code)\n", "")
        return subprocess.CompletedProcess(cmd, 0, json.dumps({"loggedIn": True, "authMethod": "claude.ai"}), "")


def test_status_is_cached_60s_and_reports_version_models_and_path() -> None:
    now = [1000.0]
    runner = AuthRunner()
    cli = ClaudeCliProvider(executable="/x/claude", runner=runner, clock=lambda: now[0])
    first = asyncio.run(cli.status())
    assert first.available is True
    assert first.version == "2.1.303 (Claude Code)"
    assert first.executable == "/x/claude"
    assert first.models == ["sonnet", "opus", "haiku"]
    assert len(runner.calls) == 2
    now[0] += 59
    asyncio.run(cli.status())
    assert len(runner.calls) == 2  # en cache
    now[0] += 2
    asyncio.run(cli.status())
    assert len(runner.calls) == 4  # revérifié après 60 s
    cli.invalidate()
    asyncio.run(cli.status())
    assert len(runner.calls) == 6


def test_cli_found_after_launch_is_picked_up() -> None:
    """Claude Code installé pendant que l'application tourne : retrouvé à la vérification suivante."""
    found: list[str | None] = [None]
    cli = ClaudeCliProvider(runner=AuthRunner(), finder=lambda: found[0], clock=lambda: 0.0)
    assert asyncio.run(cli.status()).available is False
    found[0] = "/Users/moi/.local/bin/claude"
    cli.invalidate()
    assert asyncio.run(cli.status()).available is True


def test_model_follows_user_choice() -> None:
    choice: list[str | None] = ["opus"]
    runner = FakeRunner(stdout=result_json("ok"))
    cli = ClaudeCliProvider(executable="claude", model="sonnet", runner=runner, model_choice=lambda: choice[0])
    asyncio.run(cli.chat(MSG))
    cmd = runner.calls[0]["cmd"]
    assert cmd[cmd.index("--model") + 1] == "opus"
    choice[0] = None
    assert cli.model == "sonnet"
