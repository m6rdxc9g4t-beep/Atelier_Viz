"""Fournisseur Claude via la CLI Claude Code (`claude -p`), qui consomme l'abonnement claude.ai.

Pourquoi la CLI : l'API Anthropic est facturée à part des forfaits claude.ai, alors que
`claude -p`, connecté avec un compte Pro/Max, puise dans les limites du forfait.
Usage prévu : application personnelle, en local. Pour une application partagée ou hébergée,
utiliser `CLAUDE_MODE=api` avec une clé de la Console Claude.

Isolation de chaque appel :
- `--safe-mode`        : ignore CLAUDE.md, mémoire, hooks, plugins, MCP de l'utilisateur ;
- `--tools ""`         : aucun outil (pas de shell, pas de fichiers) — Claude ne fait que répondre ;
- `--system-prompt`    : remplace entièrement le prompt système de Claude Code ;
- `--no-session-persistence` : rien n'est écrit dans l'historique des sessions ;
- répertoire de travail temporaire vide, et `ANTHROPIC_API_KEY` retirée de l'environnement
  pour que la facturation passe bien par l'abonnement ;
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` : ni télémétrie, ni rapport d'erreur, ni mise à jour automatique.

Recherche de l'exécutable (docs/SUITE.md §5.3) : `CLAUDE_CLI` (ou `CLAUDE_CLI_PATH`), sinon le `PATH`,
puis `~/.local/bin`, `/opt/homebrew/bin` et `/usr/local/bin` — une application lancée depuis le Finder
n'hérite pas du `PATH` du terminal. Disponibilité = exécutable trouvé et `claude auth status` réussi,
mise en cache 60 s (avec la version).

Le sous-processus est lancé dans un thread (`subprocess.run`) plutôt qu'avec
`asyncio.create_subprocess_exec` : sous Windows, `uvicorn --reload` utilise une boucle
d'événements qui ne gère pas les sous-processus asynchrones.
"""

import asyncio
import json
import os
import shutil
import subprocess
import tempfile
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.schemas.ai import ChatMessage, ProviderName, ProviderStatus
from app.services.ai.base import AIProviderError, extract_json

Runner = Callable[..., subprocess.CompletedProcess[str]]

DEFAULT_SYSTEM_PROMPT = "Tu es l'assistant d'une application de Business Intelligence. Réponds en français."
API_KEY_AUTH_METHODS = {"api_key", "api_key_helper"}
ROLE_LABELS = {"user": "Utilisateur", "assistant": "Assistant"}
CLAUDE_MODELS = ["sonnet", "opus", "haiku"]
"""Alias proposés à l'utilisateur (docs/SUITE.md §5.2), Sonnet par défaut."""
FALLBACK_DIRS = ("~/.local/bin", "/opt/homebrew/bin", "/usr/local/bin")
STATUS_TTL_SECONDS = 60.0


def find_claude_cli(
    executable: str = "claude",
    *,
    env: Mapping[str, str] | None = None,
    which: Callable[[str], str | None] = shutil.which,
    fallback_dirs: Sequence[str] = FALLBACK_DIRS,
) -> str | None:
    """Chemin de la CLI `claude`, ou None.

    Ordre : variable `CLAUDE_CLI`, exécutable configuré (`CLAUDE_CLI_PATH`), `PATH`, puis les dossiers
    d'installation habituels (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`).
    """
    env = os.environ if env is None else env
    candidates = [env.get("CLAUDE_CLI", "").strip(), executable.strip(), "claude"]
    for candidate in dict.fromkeys(c for c in candidates if c):
        found = which(os.path.expanduser(candidate))
        if found:
            return found
    for folder in fallback_dirs:
        path = Path(folder).expanduser() / "claude"
        if path.is_file() and os.access(path, os.X_OK):
            return str(path)
    return None


@dataclass(frozen=True)
class _AuthState:
    """Résultat mis en cache de `claude auth status` (et de `claude --version`)."""

    available: bool
    detail: str | None
    version: str | None
    checked_at: float


class ClaudeCliProvider:
    """Appelle `claude -p --output-format json` et renvoie le champ `result`.

    Args:
        executable: commande ou chemin de la CLI (`claude` par défaut ; voir `find_claude_cli`).
        model: alias (`sonnet`, `opus`, `haiku`) ou identifiant complet du modèle, par défaut.
        timeout: délai maximal d'une réponse, en secondes.
        runner: remplaçant de `subprocess.run` (tests) ; l'exécutable est alors pris tel quel.
        model_choice: modèle choisi par l'utilisateur (préférences), lu à chaque appel ; None = `model`.
        finder: recherche de l'exécutable (tests) ; par défaut `find_claude_cli(executable)`.
        clock: horloge du cache d'état (tests).
    """

    name: ProviderName = "anthropic"

    def __init__(
        self,
        executable: str = "claude",
        model: str = "sonnet",
        timeout: float = 180.0,
        runner: Runner | None = None,
        model_choice: Callable[[], str | None] | None = None,
        finder: Callable[[], str | None] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.default_model = model
        self.timeout = timeout
        self._runner: Runner = runner or subprocess.run
        self._model_choice = model_choice
        if finder is None:
            finder = (lambda: executable) if runner is not None else (lambda: find_claude_cli(executable))
        self._finder = finder
        self._clock = clock
        self._path = finder()
        self._auth: _AuthState | None = None

    @property
    def model(self) -> str:
        """Modèle utilisé pour le prochain appel : choix de l'utilisateur, sinon la configuration."""
        chosen = self._model_choice() if self._model_choice else None
        return chosen or self.default_model

    @property
    def configured(self) -> bool:
        """Vrai si l'exécutable `claude` a été trouvé."""
        return self._path is not None

    @property
    def models(self) -> list[str]:
        """Modèles proposés à l'utilisateur (alias de la CLI)."""
        return list(CLAUDE_MODELS)

    @property
    def executable(self) -> str | None:
        """Chemin de la CLI trouvée (affiché dans les réglages)."""
        return self._path

    async def status(self) -> ProviderStatus:
        """Vérifie la connexion via `claude auth status` (aucun token consommé), en cache 60 s."""
        now = self._clock()
        if self._auth is None or now - self._auth.checked_at >= STATUS_TTL_SECONDS:
            self._auth = await self._check(now)
        return self._status(self._auth.available, self._auth.detail, self._auth.version)

    def invalidate(self) -> None:
        """Oublie l'état en cache (bouton « Revérifier »)."""
        self._auth = None

    async def _check(self, now: float) -> _AuthState:
        if self._path is None:
            self._path = self._finder()  # installée depuis le lancement ?
        if self._path is None:
            return _AuthState(
                False, "CLI `claude` introuvable : installez Claude Code puis `claude auth login`", None, now
            )
        try:
            proc = await self._run(["auth", "status"], stdin=None, timeout=15)
            info: dict[str, Any] = json.loads(proc.stdout or "{}")
        except (AIProviderError, json.JSONDecodeError):
            detail = "Impossible de lire `claude auth status` (mettez à jour : `claude update`)"
            return _AuthState(False, detail, await self._version(), now)
        version = await self._version()

        if not info.get("loggedIn"):
            return _AuthState(False, "CLI non connectée : lancez `claude auth login`", version, now)
        method = str(info.get("authMethod", ""))
        if method in API_KEY_AUTH_METHODS:
            detail = "Attention : la CLI utilise une clé API (facturation API, pas l'abonnement)"
            return _AuthState(True, detail, version, now)
        return _AuthState(True, None, version, now)

    async def _version(self) -> str | None:
        """`claude --version` (ex. « 2.1.303 (Claude Code) ») ; None si illisible."""
        try:
            proc = await self._run(["--version"], stdin=None, timeout=15)
        except AIProviderError:
            return None
        text = (proc.stdout or "").strip().splitlines()
        return text[0][:80] if proc.returncode == 0 and text else None

    async def chat(self, messages: list[ChatMessage], system: str | None = None) -> str:
        payload = await self._ask(messages, system)
        result = payload.get("result")
        if not isinstance(result, str):
            raise AIProviderError("anthropic", "Claude (CLI) : champ `result` absent de la réponse.")
        return result

    async def chat_json(
        self, messages: list[ChatMessage], system: str | None, schema: dict[str, Any]
    ) -> dict[str, Any]:
        """Sortie structurée native de la CLI (`--json-schema`) : le JSON est validé par Claude Code."""
        payload = await self._ask(messages, system, ["--json-schema", json.dumps(schema, ensure_ascii=False)], turns=2)
        structured = payload.get("structured_output")
        if isinstance(structured, dict):
            return structured
        return extract_json("anthropic", str(payload.get("result") or ""))

    async def _ask(
        self, messages: list[ChatMessage], system: str | None, extra: Sequence[str] = (), turns: int = 1
    ) -> dict[str, Any]:
        """Lance `claude -p` isolé et retourne l'objet JSON final (`type: result`)."""
        if self._path is None:
            self._path = self._finder()
        if self._path is None:
            raise AIProviderError("anthropic", "CLI `claude` introuvable sur cette machine.", 400)

        args = [
            "-p",
            "--safe-mode",
            "--output-format",
            "json",
            "--tools",
            "",
            "--strict-mcp-config",
            "--disable-slash-commands",
            "--no-session-persistence",
            "--max-turns",
            str(turns),
            "--model",
            self.model,
            "--system-prompt",
            system or DEFAULT_SYSTEM_PROMPT,
            *extra,
        ]
        proc = await self._run(args, stdin=format_conversation(messages), timeout=self.timeout)
        payload = parse_result(proc.stdout)
        if payload is None:
            detail = (proc.stderr or proc.stdout or "").strip()[:300]
            if "unknown option" in detail:
                detail += " — mettez la CLI à jour : `claude update`"
            raise AIProviderError("anthropic", f"Réponse illisible de la CLI Claude : {detail}")
        if payload.get("is_error") or proc.returncode != 0:
            raise AIProviderError("anthropic", f"Claude (CLI) : {payload.get('result') or 'erreur inconnue'}")
        return payload

    async def aclose(self) -> None:
        return None

    async def _run(self, args: Sequence[str], *, stdin: str | None, timeout: float) -> subprocess.CompletedProcess[str]:
        """Exécute la CLI dans un dossier vide, sans clé API dans l'environnement."""
        env = {k: v for k, v in os.environ.items() if k != "ANTHROPIC_API_KEY"}
        # Seul l'appel au modèle sort de la machine : pas de télémétrie, de rapport d'erreur ni de mise à jour auto.
        env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"
        with tempfile.TemporaryDirectory(prefix="atelier-viz-claude-") as cwd:
            try:
                return await asyncio.to_thread(
                    self._runner,
                    [str(self._path), *args],
                    input=stdin,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    timeout=timeout,
                    cwd=cwd,
                    env=env,
                )
            except subprocess.TimeoutExpired as exc:
                raise AIProviderError("anthropic", f"Claude (CLI) n'a pas répondu en {timeout:.0f} s.", 504) from exc
            except OSError as exc:
                raise AIProviderError("anthropic", f"Impossible de lancer la CLI Claude : {exc}") from exc

    def _status(self, available: bool, detail: str | None, version: str | None = None) -> ProviderStatus:
        return ProviderStatus(
            name="anthropic",
            available=available,
            model=f"{self.model} (CLI)",
            detail=detail,
            models=list(CLAUDE_MODELS),
            version=version,
            executable=self._path,
        )


def format_conversation(messages: list[ChatMessage]) -> str:
    """`claude -p` reçoit un seul prompt : l'historique est rendu sous forme de transcription."""
    if len(messages) == 1:
        return messages[0].content
    lines = [f"{ROLE_LABELS[m.role]} : {m.content}" for m in messages]
    return (
        "Voici la conversation jusqu'ici :\n\n"
        + "\n\n".join(lines)
        + "\n\nRéponds au dernier message de l'utilisateur, sans préfixe."
    )


def parse_result(stdout: str | None) -> dict[str, Any] | None:
    """Extrait l'objet JSON final (`type: result`) de la sortie standard."""
    for line in reversed((stdout or "").strip().splitlines()):
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict) and data.get("type") == "result":
            return data
    return None
