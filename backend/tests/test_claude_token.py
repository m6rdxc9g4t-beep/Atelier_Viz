"""Mode jeton de Claude (`CLAUDE_OAUTH_TOKEN`) : exécutant simulé, la vraie CLI n'est jamais lancée.

Décision de l'utilisateur : « je veux que Claude forfait cli soit actif car c'est personnel ça sera mon forfait
Claude ». Le jeton ne doit se trouver que dans l'environnement de la CLI, et seulement dans ce mode.
"""

import asyncio
import json
import logging
import os
import stat
import subprocess
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app import claude_token, desktop, launcher
from app.api.deps import build_ai_service, build_claude_provider
from app.core.config import Settings
from app.schemas.ai import ChatMessage
from app.services.ai import AIProviderError, AnthropicProvider, ClaudeCliProvider
from app.services.ai import claude_cli as cli_module
from app.services.ai.claude_cli import TOKEN_NO_CLI, TOKEN_READY, TOKEN_REFUSED
from main import create_app
from tests.conftest import FakeProvider
from tests.test_claude_cli_provider import FakeRunner, result_json

TOKEN = "sk-ant-oat01-" + "jeton-de-test-" + "0123456789abcdef"  # forme d'un vrai jeton, valeur inventée
API_KEY = "sk-ant-api03-" + "cle-de-test-" + "0123456789abcdef"
MSG = [ChatMessage(role="user", content="Bonjour")]
CLI = "/opt/claude/bin/claude"


def token_provider(runner: FakeRunner, home: Path, **kwargs: Any) -> ClaudeCliProvider:
    return ClaudeCliProvider(
        executable=CLI, model="sonnet", runner=runner, token=claude_token.Token(TOKEN), private_home=home, **kwargs
    )


def everything(call: dict[str, Any]) -> str:
    """Tout ce qu'un appel montre hors de l'environnement : commande, entrée standard, dossier."""
    return json.dumps({k: v for k, v in call.items() if k != "env"}, ensure_ascii=False, default=str)


# --- Lecture du jeton --------------------------------------------------------------------------------------------


def test_token_is_read_once_then_removed_from_the_process_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CLAUDE_OAUTH_TOKEN", f"  {TOKEN}\n")
    token = claude_token.capture()
    assert token is not None and token.reveal() == TOKEN
    assert "CLAUDE_OAUTH_TOKEN" not in os.environ  # plus aucun sous-processus n'en hérite
    assert claude_token.capture() is token  # gardé en mémoire, l'environnement n'est pas relu
    monkeypatch.setenv("CLAUDE_OAUTH_TOKEN", "autre")
    assert claude_token.capture() is token  # une seule lecture par processus


def test_no_variable_means_no_token(monkeypatch: pytest.MonkeyPatch) -> None:
    assert claude_token.capture() is None
    monkeypatch.setenv("CLAUDE_OAUTH_TOKEN", "   ")
    claude_token.forget()
    assert claude_token.capture() is None and "CLAUDE_OAUTH_TOKEN" not in os.environ


def test_token_never_shows_in_a_repr_or_a_copy() -> None:
    token = claude_token.Token(TOKEN)
    assert TOKEN not in repr(token) and TOKEN not in str(token) and TOKEN not in f"{token!r} {[token]} {token}"
    with pytest.raises(TypeError):
        import pickle

        pickle.dumps(token)


def test_scrub_masks_the_token_and_anything_shaped_like_one() -> None:
    token = claude_token.Token("jeton-sans-forme-connue")
    text = f"refusé : jeton-sans-forme-connue, {TOKEN} et {API_KEY}."
    assert (
        claude_token.scrub(text, token) == f"refusé : {claude_token.MASK}, {claude_token.MASK} et {claude_token.MASK}."
    )


def test_private_home_is_created_for_this_user_only(tmp_path: Path) -> None:
    home = claude_token.private_home(tmp_path / "data")
    assert home == (tmp_path / "data" / "claude-forfait").resolve() and home.is_absolute()
    config = claude_token.ensure_private_home(home)
    assert config == home / ".claude" and config.is_dir()
    if os.name != "nt":
        assert stat.S_IMODE(home.stat().st_mode) == 0o700 and stat.S_IMODE(config.stat().st_mode) == 0o700
    assert claude_token.ensure_private_home(home) == config  # déjà là : rien ne change


# --- Environnement et commande de la CLI -------------------------------------------------------------------------


def test_token_goes_only_to_the_cli_environment_with_a_private_home(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", API_KEY)
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "ne-doit-pas-partir")
    monkeypatch.setenv("HOME", "/home/quelquun")
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", "/home/quelquun/.claude")
    home = tmp_path / "claude-forfait"
    runner = FakeRunner(stdout=result_json("Salut !"))
    assert asyncio.run(token_provider(runner, home).chat(MSG, system="Sois bref")) == "Salut !"

    call = runner.calls[0]
    env = call["env"]
    assert env["CLAUDE_CODE_OAUTH_TOKEN"] == TOKEN
    assert env["HOME"] == str(home) and env["CLAUDE_CONFIG_DIR"] == str(home / ".claude")
    assert (home / ".claude").is_dir()  # pas de session d'utilisateur à lire : dossier privé, créé au besoin
    assert "CLAUDE_OAUTH_TOKEN" not in env
    assert not [k for k in env if k.upper().startswith("ANTHROPIC")]  # jamais la clé API : c'est le forfait qui sert
    assert env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] == "1"
    allowed = {"HOME", "USER", "LOGNAME", "PATH", "SHELL", "LANG", "TMPDIR", "TZ", "CLAUDE_CONFIG_DIR"}
    extra = {"CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"}
    if os.name != "nt":  # liste blanche de §5.3, plus le jeton : rien d'autre
        assert all(k in allowed | extra or k.startswith("LC_") for k in env), sorted(env)
    assert TOKEN not in everything(call)  # ni argument, ni entrée standard, ni dossier de travail
    assert call["input"] == "Bonjour"  # les données restent sur l'entrée standard


def test_token_mode_keeps_exactly_the_isolation_flags(tmp_path: Path) -> None:
    plain, by_token = FakeRunner(stdout=result_json('{"a": "b"}')), FakeRunner(stdout=result_json('{"a": "b"}'))
    schema = {"type": "object", "properties": {"a": {"type": "string"}}}
    asyncio.run(ClaudeCliProvider(executable=CLI, runner=plain).chat_json(MSG, "Consigne", schema))
    asyncio.run(token_provider(by_token, tmp_path / "h").chat_json(MSG, "Consigne", schema))
    cmd = by_token.calls[0]["cmd"]
    assert cmd == plain.calls[0]["cmd"]  # mêmes arguments, dans le même ordre
    assert cmd[:2] == [CLI, "-p"] and cmd[cmd.index("--tools") + 1] == ""
    for flag in ("--safe-mode", "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands"):
        assert flag in cmd
    cwd = Path(by_token.calls[0]["cwd"])
    assert cwd.name.startswith("atelier-viz-claude-") and cwd != tmp_path / "h"  # dossier de travail vide, à part


def test_without_token_nothing_changes(monkeypatch: pytest.MonkeyPatch) -> None:
    """Sans jeton : session de l'utilisateur, son HOME, et jamais un jeton trouvé dans l'environnement du processus."""
    monkeypatch.setenv("HOME", "/home/quelquun")
    monkeypatch.setenv("CLAUDE_CODE_OAUTH_TOKEN", "jeton-d-une-autre-application")
    runner = FakeRunner(stdout=json.dumps({"loggedIn": True, "authMethod": "claude.ai"}))
    provider = ClaudeCliProvider(executable=CLI, runner=runner)
    status = asyncio.run(provider.status())
    assert runner.calls[0]["cmd"] == [CLI, "auth", "status"]  # disponibilité : toujours la session `claude`
    assert status.available and status.access == "cli" and status.detail is None
    runner.stdout = result_json("ok")
    asyncio.run(provider.chat(MSG))
    env = runner.calls[-1]["env"]
    assert "CLAUDE_CODE_OAUTH_TOKEN" not in env and "CLAUDE_OAUTH_TOKEN" not in env
    if os.name != "nt":
        assert env["HOME"] == "/home/quelquun"


def test_a_token_needs_a_private_home() -> None:
    with pytest.raises(ValueError, match="dossier privé"):
        ClaudeCliProvider(executable=CLI, runner=FakeRunner(), token=claude_token.Token(TOKEN))


# --- Disponibilité et état ---------------------------------------------------------------------------------------


def test_status_by_token_is_executable_plus_token_without_auth_status(tmp_path: Path) -> None:
    runner = FakeRunner(stdout="2.1.303 (Claude Code)\n")
    provider = token_provider(runner, tmp_path / "h")
    status = asyncio.run(provider.status())
    assert status.available is True and status.access == "token"
    assert status.detail == TOKEN_READY == "Forfait Claude, par jeton"
    assert status.version == "2.1.303 (Claude Code)" and status.executable == CLI
    assert [c["cmd"] for c in runner.calls] == [[CLI, "--version"]]  # jamais `claude auth status`
    version_env = runner.calls[0]["env"]
    assert "CLAUDE_CODE_OAUTH_TOKEN" not in version_env  # le jeton ne part que pour une demande
    assert version_env["HOME"] == str(tmp_path / "h")
    assert TOKEN not in status.model_dump_json()  # l'état dit le mode, jamais le jeton


def test_status_by_token_when_the_cli_is_missing_from_the_image(tmp_path: Path) -> None:
    runner = FakeRunner()
    provider = token_provider(runner, tmp_path / "h", finder=lambda: None)
    status = asyncio.run(provider.status())
    assert status.available is False and status.access == "token"
    assert status.detail == TOKEN_NO_CLI and "CLAUDE_OAUTH_TOKEN" in TOKEN_NO_CLI and "absent" in TOKEN_NO_CLI
    with pytest.raises(AIProviderError) as info:
        asyncio.run(provider.chat(MSG))
    assert info.value.status_code == 400 and info.value.message == TOKEN_NO_CLI
    assert runner.calls == []  # rien n'est lancé


# --- Erreurs dites en français, sans secret ----------------------------------------------------------------------


@pytest.mark.parametrize(
    "said",
    [
        "Invalid API key · Please run /login",
        'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired."}}',
        "Invalid bearer token",
        f"Failed to authenticate with {TOKEN}",
    ],
)
def test_refused_or_expired_token_says_what_to_do(said: str, tmp_path: Path) -> None:
    runner = FakeRunner(stdout=result_json(said, is_error=True), returncode=1)
    provider = token_provider(runner, tmp_path / "h")
    with pytest.raises(AIProviderError) as info:
        asyncio.run(provider.chat(MSG))
    assert info.value.message == TOKEN_REFUSED and info.value.status_code == 503
    assert "claude setup-token" in TOKEN_REFUSED and "jeton du serveur" in TOKEN_REFUSED
    assert TOKEN not in info.value.message and TOKEN not in str(info.value)

    # Claude s'éteint (« Auto » passe par Ollama) tant qu'on n'a pas revérifié : le jeton ne change qu'au redémarrage.
    status = asyncio.run(provider.status())
    assert status.available is False and status.detail == TOKEN_REFUSED
    assert provider.invalidate() is True
    runner.stdout, runner.returncode = result_json("Salut !"), 0
    assert asyncio.run(provider.status()).available is True
    assert asyncio.run(provider.chat(MSG)) == "Salut !"


def test_refused_token_read_on_stderr(tmp_path: Path) -> None:
    runner = FakeRunner(stdout="", stderr="Error: OAuth token revoked · Please run /login", returncode=1)
    with pytest.raises(AIProviderError) as info:
        asyncio.run(token_provider(runner, tmp_path / "h").chat(MSG))
    assert info.value.message == TOKEN_REFUSED


@pytest.mark.parametrize(
    "said",
    ["Claude AI usage limit reached|1794571200", "You've hit your limit · resets 3pm (run /login to switch account)"],
)
def test_plan_limit_repeats_the_cli_message_and_is_not_a_refusal(said: str, tmp_path: Path) -> None:
    runner = FakeRunner(stdout=result_json(said, is_error=True), returncode=1)
    provider = token_provider(runner, tmp_path / "h")
    with pytest.raises(AIProviderError) as info:
        asyncio.run(provider.chat(MSG))
    assert info.value.status_code == 429
    assert "Limite du forfait Claude atteinte" in info.value.message and said in info.value.message
    assert "partagé entre les applications de la suite" in info.value.message
    assert "setup-token" not in info.value.message  # refaire le jeton n'y changerait rien
    runner.stdout, runner.returncode = "2.1.303 (Claude Code)", 0
    assert asyncio.run(provider.status()).available is True  # le jeton reste bon


def test_other_errors_never_show_the_token(tmp_path: Path) -> None:
    echoed = FakeRunner(stdout=result_json(f"Model not found ({TOKEN})", is_error=True), returncode=1)
    with pytest.raises(AIProviderError) as info:
        asyncio.run(token_provider(echoed, tmp_path / "h").chat(MSG))
    assert "Model not found" in info.value.message and TOKEN not in info.value.message
    assert claude_token.MASK in info.value.message

    # Sortie illisible : masquée avant d'être coupée (un jeton à cheval sur la coupe resterait en partie lisible).
    unreadable = FakeRunner(stdout="", stderr="x" * 280 + TOKEN, returncode=1)
    with pytest.raises(AIProviderError) as info:
        asyncio.run(token_provider(unreadable, tmp_path / "h").chat(MSG))
    assert "Réponse illisible" in info.value.message and TOKEN[:20] not in info.value.message

    late = FakeRunner(exc=subprocess.TimeoutExpired([CLI, "-p"], 1))
    with pytest.raises(AIProviderError) as info:
        asyncio.run(token_provider(late, tmp_path / "h").chat(MSG))
    assert info.value.status_code == 504 and TOKEN not in info.value.message


def test_a_number_that_contains_401_is_not_a_refusal(tmp_path: Path) -> None:
    runner = FakeRunner(stdout=result_json("Prompt is too long: 240131 tokens", is_error=True), returncode=1)
    provider = token_provider(runner, tmp_path / "h")
    with pytest.raises(AIProviderError) as info:
        asyncio.run(provider.chat(MSG))
    assert "Prompt is too long" in info.value.message and info.value.message != TOKEN_REFUSED


# --- Choix du moteur ---------------------------------------------------------------------------------------------


def test_a_token_takes_precedence_over_the_mode_and_the_api_key(tmp_path: Path) -> None:
    """Sur le VPS le service reçoit `CLAUDE_MODE=api` : avec un jeton, c'est la CLI par jeton qui sert."""
    settings = Settings(claude_mode="api", anthropic_api_key=API_KEY, data_dir=tmp_path, _env_file=None)  # type: ignore[call-arg,arg-type]
    by_token = build_claude_provider(settings, token=claude_token.Token(TOKEN))
    assert isinstance(by_token, ClaudeCliProvider) and by_token.access == "token"
    assert by_token._private_home == (tmp_path / "claude-forfait").resolve()  # noqa: SLF001 — dossier sous DATA_DIR

    # Sans jeton, rien ne change : la clé en mode « api », la session `claude` en mode « cli ».
    assert isinstance(build_claude_provider(settings), AnthropicProvider)
    cli = build_claude_provider(Settings(claude_mode="cli", data_dir=tmp_path, _env_file=None))  # type: ignore[call-arg]
    assert isinstance(cli, ClaudeCliProvider) and cli.access == "cli" and cli._token is None  # noqa: SLF001


def test_service_reads_the_token_from_the_environment_once(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("CLAUDE_OAUTH_TOKEN", TOKEN)
    settings = Settings(claude_mode="api", anthropic_api_key=None, data_dir=tmp_path, _env_file=None)  # type: ignore[call-arg]
    service = build_ai_service(settings)
    assert isinstance(service.anthropic, ClaudeCliProvider) and service.anthropic.access == "token"
    assert "CLAUDE_OAUTH_TOKEN" not in os.environ


# --- Application entière -----------------------------------------------------------------------------------------


@pytest.fixture
def token_app(
    settings: Settings, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> tuple[TestClient, FakeRunner]:
    """Application réelle lancée avec le jeton dans l'environnement, une clé API et `CLAUDE_MODE=api` (comme le VPS)."""
    runner = FakeRunner(stdout=result_json("Salut !"))
    monkeypatch.setattr(cli_module, "run_bounded", runner)
    monkeypatch.setattr(cli_module, "find_claude_cli", lambda *a, **k: CLI)
    monkeypatch.setenv("CLAUDE_OAUTH_TOKEN", TOKEN)
    monkeypatch.setenv("ANTHROPIC_API_KEY", API_KEY)
    caplog.set_level(logging.DEBUG)
    with_key = settings.model_copy(update={"anthropic_api_key": API_KEY})
    with TestClient(create_app(with_key)) as client:
        client.app.state.ai_service.ollama = FakeProvider("ollama")  # type: ignore[attr-defined]  # aucun réseau
        yield client, runner  # type: ignore[misc]


def test_offline_refuses_claude_and_launches_nothing(token_app: tuple[TestClient, FakeRunner]) -> None:
    client, runner = token_app
    assert "CLAUDE_OAUTH_TOKEN" not in os.environ  # retiré dès la création de l'application
    body = {"messages": [{"role": "user", "content": "Bonjour"}], "provider": "anthropic"}
    response = client.post("/api/ai/chat", json=body)
    assert response.status_code == 403 and "hors ligne" in response.json()["detail"]

    providers = client.get("/api/ai/providers?refresh=true")
    claude = next(p for p in providers.json()["providers"] if p["name"] == "anthropic")
    assert claude["available"] is False and claude["detail"] == "Désactivé : mode hors ligne"
    assert claude["access"] == "token"
    assert runner.calls == []  # hors ligne, la CLI n'est même pas lancée (ni `--version`)
    assert TOKEN not in response.text and TOKEN not in providers.text


def test_online_the_cli_answers_by_token_and_the_token_shows_nowhere(
    token_app: tuple[TestClient, FakeRunner], settings: Settings, caplog: pytest.LogCaptureFixture
) -> None:
    client, runner = token_app
    assert client.put("/api/settings", json={"online_mode": True}).status_code == 200

    providers = client.get("/api/ai/providers")
    claude = next(p for p in providers.json()["providers"] if p["name"] == "anthropic")
    assert claude["available"] is True and claude["access"] == "token"
    assert claude["detail"] == "Forfait Claude, par jeton" and claude["model"] == "sonnet (CLI)"

    for provider in ("anthropic", "auto"):  # « Auto » en ligne prend Claude : il est disponible
        body = {"messages": [{"role": "user", "content": "Bonjour"}], "provider": provider}
        chat = client.post("/api/ai/chat", json=body)
        assert chat.status_code == 200 and chat.json()["provider"] == "anthropic"
        assert TOKEN not in chat.text
    asked = [c for c in runner.calls if "-p" in c["cmd"]]
    assert len(asked) == 2
    for call in asked:
        assert call["env"]["CLAUDE_CODE_OAUTH_TOKEN"] == TOKEN
        assert call["env"]["HOME"] == str((settings.data_dir / "claude-forfait").resolve())
        assert not [k for k in call["env"] if k.upper().startswith("ANTHROPIC")]  # la clé du processus ne part pas
        assert TOKEN not in everything(call)
    assert not any("auth" in c["cmd"] for c in runner.calls)

    # Jeton refusé : message en français, sans secret ; la pastille s'éteint avec l'explication.
    runner.stdout, runner.returncode = result_json(f"Invalid API key ({TOKEN})", is_error=True), 1
    refused = client.post("/api/ai/chat", json={"messages": [{"role": "user", "content": "Bonjour"}]})
    assert refused.status_code == 503 and refused.json()["detail"] == TOKEN_REFUSED
    after = client.get("/api/ai/providers")
    claude = next(p for p in after.json()["providers"] if p["name"] == "anthropic")
    assert claude["available"] is False and claude["detail"] == TOKEN_REFUSED

    # Nulle part ailleurs : réponses, journaux, fichiers du dossier de données, environnement du processus.
    assert TOKEN not in providers.text + refused.text + after.text + client.get("/api/settings").text
    assert TOKEN not in caplog.text
    read = 0
    for path in settings.data_dir.rglob("*"):
        if path.is_file():
            try:
                content = path.read_bytes()
            except OSError:  # Windows : la base DuckDB ouverte est verrouillée
                continue
            read += 1
            assert TOKEN.encode() not in content, path
    assert read >= 1  # au moins settings.json
    assert TOKEN not in json.dumps(dict(os.environ))


def test_without_token_the_application_is_unchanged(client: TestClient) -> None:
    """Sans jeton : mode « api » sans clé (réglages des tests), comme avant."""
    assert isinstance(client.app.state.ai_service.anthropic, AnthropicProvider)  # type: ignore[attr-defined]
    client.app.state.ai_service.ollama = FakeProvider("ollama")  # type: ignore[attr-defined]  # aucun réseau
    client.put("/api/settings", json={"online_mode": True})
    claude = next(p for p in client.get("/api/ai/providers").json()["providers"] if p["name"] == "anthropic")
    assert claude["available"] is False and claude["access"] == "api" and "ANTHROPIC_API_KEY" in claude["detail"]


# --- Application de bureau : la mise à jour n'hérite pas du jeton ------------------------------------------------


def test_desktop_update_never_inherits_the_token(monkeypatch: pytest.MonkeyPatch) -> None:
    """Le jeton est retiré de l'environnement avant la mise à jour (git, npm, pip), et gardé pour le serveur."""
    monkeypatch.setenv("CLAUDE_OAUTH_TOKEN", TOKEN)
    seen: list[bool] = []

    class Updater:
        def plan(self) -> launcher.Plan:
            seen.append("CLAUDE_OAUTH_TOKEN" in os.environ)
            return launcher.Plan(launcher.RepoState("h", "", "l", "r"), ())

    monkeypatch.setattr(desktop, "_run_browser", lambda: 0)
    assert desktop.run(["--browser"], auto_update=True, updater_factory=Updater) == 0  # type: ignore[arg-type]
    assert seen == [False]
    kept = claude_token.capture()
    assert kept is not None and kept.reveal() == TOKEN  # le serveur, lancé ensuite, le retrouve en mémoire


def test_command_line_update_drops_the_token() -> None:
    env = {"PATH": "/usr/bin", "CLAUDE_OAUTH_TOKEN": TOKEN, "Claude_OAuth_Token": TOKEN, "CLAUDE_CLI": "/opt/claude"}
    launcher.drop_claude_token(env)
    assert env == {"PATH": "/usr/bin", "CLAUDE_CLI": "/opt/claude"}
