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
    assert call["max_output"] == 4 * 1024 * 1024  # sortie bornée


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


def _exe(folder, name: str = "claude"):  # type: ignore[no-untyped-def]
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / name
    path.write_text("#!/bin/sh\n")
    path.chmod(0o755)
    return path


@pytest.mark.skipif(__import__("os").name != "posix", reason="exécutables POSIX ; Windows : test_windows.py")
def test_find_claude_cli_order(tmp_path) -> None:
    """CLAUDE_CLI (absolu), puis l'exécutable configuré, puis le PATH, puis les dossiers d'installation."""
    import os

    from app.services.ai.claude_cli import FALLBACK_DIRS, find_claude_cli

    assert FALLBACK_DIRS == ("~/.local/bin", "/opt/homebrew/bin", "/usr/local/bin")
    env_exe = _exe(tmp_path / "env", "claude-env")
    in_path = _exe(tmp_path / "bin")
    path = str(tmp_path / "bin")
    env = {"CLAUDE_CLI": str(env_exe), "PATH": path}
    assert find_claude_cli("claude", env=env, fallback_dirs=()) == str(env_exe)
    # Exécutable configuré absent : recherche dans le PATH ; résultat toujours absolu.
    found = find_claude_cli(str(tmp_path / "introuvable" / "claude"), env={"PATH": path}, fallback_dirs=())
    assert found == str(in_path) and os.path.isabs(found)
    # Simple nom (CLAUDE_CLI_PATH=claude de .env.example) : cherché dans le PATH.
    assert find_claude_cli("claude", env={"PATH": path}, fallback_dirs=()) == str(in_path)


@pytest.mark.skipif(__import__("os").name != "posix", reason="exécutables POSIX ; Windows : test_windows.py")
def test_find_claude_cli_refuses_relative_paths_and_node_modules(tmp_path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Chemin relatif refusé, entrées relatives du PATH et dossiers node_modules/.bin ignorés (§5.3)."""
    from app.services.ai.claude_cli import find_claude_cli

    _exe(tmp_path / "rel")
    node_bin = tmp_path / "projet" / "node_modules" / ".bin"
    _exe(node_bin)
    monkeypatch.chdir(tmp_path)
    for value in ("rel/claude", "./rel/claude"):
        assert find_claude_cli(value, env={"PATH": ""}, fallback_dirs=()) is None
        assert find_claude_cli("claude", env={"CLAUDE_CLI": value, "PATH": ""}, fallback_dirs=()) is None
    assert find_claude_cli("claude", env={"PATH": "rel"}, fallback_dirs=()) is None
    assert find_claude_cli("claude", env={"PATH": str(node_bin)}, fallback_dirs=()) is None
    good = _exe(tmp_path / "usr" / "bin")
    path = f"rel:{node_bin}:{good.parent}".replace(":", __import__("os").pathsep)
    assert find_claude_cli("claude", env={"PATH": path}, fallback_dirs=()) == str(good)


@pytest.mark.skipif(__import__("os").name != "posix", reason="exécutables POSIX ; Windows : test_windows.py")
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


# --- Environnement en liste blanche, sortie bornée, arrêt forcé (docs/SUITE.md §5.3) ---


@pytest.mark.skipif(__import__("os").name != "posix", reason="exécutables POSIX ; Windows : test_windows.py")
def test_cli_environment_is_an_exact_allow_list() -> None:
    from app.services.ai.claude_cli import cli_environment

    source = {
        "HOME": "/Users/moi",
        "USER": "moi",
        "LOGNAME": "moi",
        "SHELL": "/bin/zsh",
        "LANG": "fr_FR.UTF-8",
        "LC_ALL": "fr_FR.UTF-8",
        "LC_CTYPE": "UTF-8",
        "TMPDIR": "/tmp/x",
        "TZ": "Europe/Paris",
        "CLAUDE_CONFIG_DIR": "/Users/moi/.claude",
        "PATH": "/usr/bin:relatif:/opt/homebrew/bin:/p/node_modules/.bin:/bin",
        "ANTHROPIC_API_KEY": "sk-secret",
        "ANTHROPIC_BASE_URL": "https://ailleurs",
        "CLAUDE_CODE_USE_BEDROCK": "1",
        "CLAUDE_CODE_USE_VERTEX": "1",
        "GITHUB_TOKEN": "ghp_secret",
        "AWS_SECRET_ACCESS_KEY": "x",
        "NODE_OPTIONS": "--require /tmp/evil.js",
        "HTTPS_PROXY": "http://proxy",
    }
    env = cli_environment("/opt/homebrew/bin/claude", source)
    assert set(env) == {
        "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TZ",
        "CLAUDE_CONFIG_DIR", "PATH", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    }  # fmt: skip
    assert env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] == "1"
    # Dossier de l'exécutable en tête (node à côté d'une CLI npm), sans doublon ni entrée relative.
    assert env["PATH"].split(":") == ["/opt/homebrew/bin", "/usr/bin", "/bin"]


def test_provider_passes_the_allow_list_to_the_cli(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CLAUDE_CODE_USE_BEDROCK", "1")
    monkeypatch.setenv("GITHUB_TOKEN", "ghp_ne_doit_pas_fuiter")
    runner = FakeRunner(stdout=result_json("ok"))
    asyncio.run(ClaudeCliProvider(executable="/x/bin/claude", runner=runner).chat(MSG))
    env = runner.calls[0]["env"]
    assert "CLAUDE_CODE_USE_BEDROCK" not in env and "GITHUB_TOKEN" not in env
    assert env["PATH"].startswith("/x/bin")  # dossier de l'exécutable en tête (« : » ou « ; »)


def test_json_schema_argument_never_carries_data_enums() -> None:
    """Les noms de colonnes (énumération marquée) ne partent pas en argument ; les autres énumérations, si."""
    from app.services.ai.base import DATA_ENUM, schema_for_model

    schema = {
        "type": "object",
        "properties": {
            "type": {"type": "string", "enum": ["column", "kpi"]},
            "field": {"type": "string", "enum": ["chiffre_affaires_secret"], DATA_ENUM: True},
        },
    }
    runner = FakeRunner(stdout=json.dumps({"type": "result", "is_error": False, "structured_output": {}}))
    asyncio.run(provider(runner).chat_json(MSG, "Consignes", schema))
    cmd = runner.calls[0]["cmd"]
    assert "chiffre_affaires_secret" not in " ".join(cmd)
    sent = json.loads(cmd[cmd.index("--json-schema") + 1])
    assert sent["properties"]["type"]["enum"] == ["column", "kpi"]
    assert sent["properties"]["field"] == {"type": "string"}
    # Ollama / API : le schéma complet, sans la marque.
    assert schema_for_model(schema)["properties"]["field"] == {"type": "string", "enum": ["chiffre_affaires_secret"]}


def test_run_bounded_returns_output_and_reads_stdin() -> None:
    import sys

    from app.services.ai.claude_cli import run_bounded

    code = "import sys; data = sys.stdin.read(); print(data.upper()); print('erreur', file=sys.stderr)"
    proc = run_bounded([sys.executable, "-c", code], input="données", timeout=20)
    assert proc.returncode == 0
    assert proc.stdout.strip() == "DONNÉES" and proc.stderr.strip() == "erreur"


def test_run_bounded_stops_oversized_output() -> None:
    import sys

    from app.services.ai.claude_cli import OutputTooLarge, run_bounded

    code = "import sys\nwhile True: sys.stdout.write('x' * 65536)"
    with pytest.raises(OutputTooLarge):
        run_bounded([sys.executable, "-c", code], timeout=20, max_output=256 * 1024)


@pytest.mark.skipif(__import__("os").name != "posix", reason="SIGTERM ignoré : POSIX seulement")
def test_run_bounded_kills_a_process_that_ignores_sigterm() -> None:
    import sys
    import time

    from app.services.ai.claude_cli import run_bounded

    code = "import signal, time\nsignal.signal(signal.SIGTERM, signal.SIG_IGN)\ntime.sleep(60)"
    started = time.monotonic()
    with pytest.raises(subprocess.TimeoutExpired):
        run_bounded([sys.executable, "-c", code], timeout=1.0, grace=0.5)
    assert time.monotonic() - started < 10  # SIGKILL après le délai de grâce, pas 60 s


def test_oversized_output_becomes_a_provider_error() -> None:
    from app.services.ai.claude_cli import OutputTooLarge

    runner = FakeRunner(exc=OutputTooLarge(4 * 1024 * 1024))
    with pytest.raises(AIProviderError, match="trop volumineuse") as info:
        asyncio.run(provider(runner).chat(MSG))
    assert info.value.status_code == 502


# --- Recherche différée (Auto) et revérification forcée limitée ---


def test_missing_cli_is_searched_again_at_most_every_60s() -> None:
    from app.services.ai import AIService
    from tests.conftest import FakeProvider

    now = [0.0]
    found: list[str | None] = [None]
    searches = [0]

    def finder() -> str | None:
        searches[0] += 1
        return found[0]

    cli = ClaudeCliProvider(runner=AuthRunner(), finder=finder, clock=lambda: now[0])
    service = AIService(FakeProvider("ollama"), cli, is_online=lambda: True)  # type: ignore[arg-type]
    assert service.claude_usable is False
    found[0] = "/Users/moi/.local/bin/claude"  # Claude Code installé après le lancement
    now[0] = 30.0
    assert service.claude_usable is False  # absence gardée en cache
    assert searches[0] == 1
    now[0] = 61.0
    assert service.claude_usable is True  # recherché de nouveau après 60 s
    assert searches[0] == 2
    assert asyncio.run(service.resolve("auto")) is cli


def test_forced_refresh_is_limited_to_every_10s() -> None:
    from app.services.ai import AIService
    from tests.conftest import FakeProvider

    now = [1000.0]
    runner = AuthRunner()
    cli = ClaudeCliProvider(executable="/x/claude", runner=runner, clock=lambda: now[0])
    service = AIService(FakeProvider("ollama"), cli, is_online=lambda: True)  # type: ignore[arg-type]
    asyncio.run(service.providers_status())
    assert len(runner.calls) == 2
    asyncio.run(service.providers_status(refresh=True))
    assert len(runner.calls) == 4  # première revérification forcée : acceptée
    now[0] += 5
    asyncio.run(service.providers_status(refresh=True))
    assert len(runner.calls) == 4  # moins de 10 s : état en cache
    now[0] += 6
    asyncio.run(service.providers_status(refresh=True))
    assert len(runner.calls) == 6
