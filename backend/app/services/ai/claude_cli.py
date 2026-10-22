"""Fournisseur Claude via la CLI Claude Code (`claude -p`), qui consomme l'abonnement claude.ai.

Pourquoi la CLI : l'API Anthropic est facturée à part des forfaits claude.ai, alors que
`claude -p`, connecté avec un compte Pro/Max, puise dans les limites du forfait.
Usage prévu : application personnelle, en local. Pour une application partagée ou hébergée,
utiliser `CLAUDE_MODE=api` avec une clé de la Console Claude.

Isolation de chaque appel (docs/SUITE.md §5.3) :
- `--safe-mode`        : ignore CLAUDE.md, mémoire, hooks, plugins, MCP de l'utilisateur ;
- `--tools ""`         : aucun outil (pas de shell, pas de fichiers) — Claude ne fait que répondre ;
- `--system-prompt`    : remplace entièrement le prompt système de Claude Code ; il ne contient que des
  consignes : **aucune donnée en argument** (visible par `ps`), la conversation et les données passent
  par l'entrée standard ; les énumérations tirées des données sont retirées de `--json-schema` ;
- `--no-session-persistence` : rien n'est écrit dans l'historique des sessions ;
- répertoire de travail temporaire vide ;
- environnement en **liste blanche** (`cli_environment`) : `HOME`, `USER`, `LOGNAME`, `PATH` (dossier de
  l'exécutable en tête), `SHELL`, `LANG`, `LC_*`, `TMPDIR`, `TZ`, `CLAUDE_CONFIG_DIR`, plus
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` — ni clé API, ni `CLAUDE_CODE_USE_BEDROCK/VERTEX`, ni secret ;
- délai maximal, puis arrêt forcé (SIGTERM puis SIGKILL du groupe de processus) ; sortie lue avec une
  taille maximale (`MAX_OUTPUT_BYTES`), jamais entièrement en mémoire sans limite (`run_bounded`).

Recherche de l'exécutable : `CLAUDE_CLI` (ou `CLAUDE_CLI_PATH`) en chemin absolu — un chemin relatif est
refusé —, sinon le `PATH` (entrées absolues seulement, dossiers `node_modules/.bin` ignorés), puis
`~/.local/bin`, `/opt/homebrew/bin` et `/usr/local/bin` — une application lancée depuis le Finder
n'hérite pas du `PATH` du terminal. Sous Windows (docs/SUITE.md §9.6) : `claude.exe` (PATH,
`%USERPROFILE%\\.local\\bin`, liens de WinGet) ; un `claude.cmd` de npm (`%APPDATA%\\npm`) est résolu en
`node.exe …\\@anthropic-ai\\claude-code\\cli.js` (`resolve_npm_shim`), sinon refusé : jamais `cmd.exe`, qui
réinterpréterait le prompt et le schéma JSON ; liste blanche complétée des variables système de §9.6
(`SystemRoot`, `USERPROFILE`, `APPDATA`…, aucune donnée ni secret), processus lancé sans console.
Disponibilité = exécutable trouvé et `claude auth status` réussi, mise en cache 60 s (avec la version) ;
revérification forcée au plus toutes les 10 s. Une CLI introuvable est recherchée de nouveau au plus toutes les
60 s (installée après le lancement).

Le sous-processus est lancé dans un thread plutôt qu'avec `asyncio.create_subprocess_exec` :
sous Windows, `uvicorn --reload` utilise une boucle d'événements qui ne gère pas les sous-processus asynchrones.
"""

import asyncio
import contextlib
import json
import logging
import os
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import IO, Any

from app.schemas.ai import ChatMessage, ProviderName, ProviderStatus
from app.services.ai.base import AIProviderError, extract_json, schema_for_model

Runner = Callable[..., subprocess.CompletedProcess[str]]

log = logging.getLogger(__name__)

DEFAULT_SYSTEM_PROMPT = "Tu es l'assistant d'une application de Business Intelligence. Réponds en français."
API_KEY_AUTH_METHODS = {"api_key", "api_key_helper"}
ROLE_LABELS = {"user": "Utilisateur", "assistant": "Assistant"}
CLAUDE_MODELS = ["sonnet", "opus", "haiku"]
"""Alias proposés à l'utilisateur (docs/SUITE.md §5.2), Sonnet par défaut."""
FALLBACK_DIRS = ("~/.local/bin", "/opt/homebrew/bin", "/usr/local/bin")
WINDOWS_FALLBACK_DIRS = (
    "%USERPROFILE%/.local/bin",
    "~/.local/bin",
    "%LOCALAPPDATA%/Microsoft/WinGet/Links",
    "%APPDATA%/npm",
)
"""Windows (docs/SUITE.md §9.6) : installateur natif (`%USERPROFILE%\\.local\\bin\\claude.exe`), WinGet, puis le
`claude.cmd` de npm (résolu en `node.exe …\\cli.js`)."""
NPM_PACKAGE = ("node_modules", "@anthropic-ai", "claude-code")
WINDOWS = os.name == "nt"
CREATE_NO_WINDOW = 0x08000000
STATUS_TTL_SECONDS = 60.0
"""Durée de vie de l'état en cache (`claude auth status`) et de l'absence d'exécutable."""
FORCED_REFRESH_SECONDS = 10.0
"""Intervalle minimal entre deux revérifications forcées (`?refresh=true`)."""
MAX_OUTPUT_BYTES = 4 * 1024 * 1024
"""Taille maximale lue sur les sorties de la CLI (stdout + stderr)."""
KILL_GRACE_SECONDS = 3.0
"""Délai laissé au processus après SIGTERM avant SIGKILL."""

ENV_ALLOWED = frozenset({"HOME", "USER", "LOGNAME", "PATH", "SHELL", "LANG", "TMPDIR", "TZ", "CLAUDE_CONFIG_DIR"})
"""Variables transmises à la CLI (docs/SUITE.md §5.3), avec les `LC_*` ; rien d'autre."""
WINDOWS_ENV_ALLOWED = frozenset(
    {
        "USERPROFILE",
        "HOMEDRIVE",
        "HOMEPATH",
        "USERNAME",
        "APPDATA",
        "LOCALAPPDATA",
        "SYSTEMROOT",
        "SYSTEMDRIVE",
        "WINDIR",
        "COMSPEC",
        "PATHEXT",
        "TEMP",
        "TMP",
        "PROGRAMDATA",
    }
)
"""Windows (docs/SUITE.md §9.6) : liste de §5.3 plus ces variables (noms sans tenir compte de la casse), `Path`."""


def _is_node_bin(folder: str) -> bool:
    """Vrai pour un dossier `…/node_modules/.bin` (exécutables d'un projet, pas de la machine)."""
    parts = [part for part in re.split(r"[\\/]", folder) if part]  # « / » et « \\ » (Windows)
    return any(a == "node_modules" and b == ".bin" for a, b in zip(parts, parts[1:], strict=False))


def _has_separator(value: str) -> bool:
    return value.startswith("~") or os.sep in value or bool(os.altsep and os.altsep in value)


def resolve_npm_shim(shim: Path, find_node: Callable[[], Path | None] | None = None) -> list[str] | None:
    """Windows : commande réelle d'un `claude.cmd` installé par npm, sans `cmd.exe` (docs/SUITE.md §9.6).

    `<dossier du .cmd>\\node_modules\\@anthropic-ai\\claude-code\\cli.js` lancé par `node.exe` (à côté du `.cmd`,
    sinon cherché comme pour la mise à jour), ou le binaire natif du paquet (`bin\\claude.exe`). None si le
    `.cmd` ne se résout pas : il est alors refusé (cmd.exe réinterpréterait le prompt et le schéma JSON).
    """
    if not shim.is_file():
        return None
    package = shim.parent.joinpath(*NPM_PACKAGE)
    native = package / "bin" / "claude.exe"
    if native.is_file():
        return [str(native)]
    script = package / "cli.js"
    if not script.is_file():
        return None
    node = shim.parent / "node.exe"
    if not node.is_file():
        from app import launcher

        node = (find_node or launcher.find_node)() or Path()
    return [str(node), str(script)] if node.name.lower() == "node.exe" and node.is_file() else None


def cli_command(executable: str, windows: bool = WINDOWS) -> list[str] | None:
    """Début de la commande de la CLI : `[claude]`, ou sous Windows `[node.exe, cli.js]` pour un `.cmd` de npm.

    None : `.cmd` / `.bat` qui ne se résout pas (jamais lancé par `cmd.exe`).
    """
    if windows and Path(executable).suffix.lower() in {".cmd", ".bat"}:
        return resolve_npm_shim(Path(executable))
    return [executable]


def _executable_file(path: Path) -> bool:
    if WINDOWS:
        if path.suffix.lower() == ".exe":
            return path.is_file()
        return path.suffix.lower() == ".cmd" and cli_command(str(path)) is not None
    return path.is_file() and os.access(path, os.X_OK)


def _windows_candidates(folder: Path, name: str) -> list[Path]:
    """`claude.exe`, puis `claude.cmd` (npm, résolu) dans un dossier."""
    if Path(name).suffix.lower() in {".exe", ".cmd"}:
        return [folder / name]
    return [folder / f"{name}.exe", folder / f"{name}.cmd"]


def find_claude_cli(
    executable: str = "claude",
    *,
    env: Mapping[str, str] | None = None,
    which: Callable[..., str | None] = shutil.which,
    fallback_dirs: Sequence[str] | None = None,
) -> str | None:
    """Chemin **absolu** de la CLI `claude`, ou None (docs/SUITE.md §5.3).

    Ordre : variable `CLAUDE_CLI`, exécutable configuré (`CLAUDE_CLI` / `CLAUDE_CLI_PATH`) s'il s'agit d'un
    chemin absolu (un chemin relatif est refusé ; un simple nom, comme `claude`, est cherché dans le `PATH`),
    puis le `PATH` — entrées absolues seulement, hors `node_modules/.bin` —, puis les dossiers d'installation
    habituels (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`).
    """
    env = os.environ if env is None else env
    configured = [v for v in dict.fromkeys((env.get("CLAUDE_CLI", "").strip(), executable.strip())) if v]
    names: list[str] = []
    for value in configured:
        if not _has_separator(value):
            names.append(value)
            continue
        path = Path(value).expanduser()
        if not path.is_absolute():
            log.warning("CLAUDE_CLI « %s » ignoré : un chemin absolu est exigé.", value)
            continue
        if _executable_file(path):
            return str(path)
    names = list(dict.fromkeys([*names, "claude"]))
    for folder in env.get("PATH", "").split(os.pathsep):
        if not folder or not os.path.isabs(folder) or _is_node_bin(folder):
            continue
        for name in names:
            if WINDOWS:
                for candidate in _windows_candidates(Path(folder), name):
                    if _executable_file(candidate):
                        return str(candidate)
                continue
            found = which(name, path=folder)
            if found and os.path.isabs(found):
                return found
    if fallback_dirs is None:
        fallback_dirs = WINDOWS_FALLBACK_DIRS if WINDOWS else FALLBACK_DIRS
    for folder in fallback_dirs:
        base = Path(os.path.expandvars(folder)).expanduser()
        for path in _windows_candidates(base, "claude") if WINDOWS else [base / "claude"]:
            if path.is_absolute() and _executable_file(path):
                return str(path)
    return None


def cli_environment(
    executable: str, source: Mapping[str, str] | None = None, windows: bool = WINDOWS
) -> dict[str, str]:
    """Environnement de la CLI, en liste blanche ; le dossier de l'exécutable en tête du `PATH`.

    Une CLI installée par npm (`#!/usr/bin/env node`) doit trouver `node` depuis le Finder : il est
    d'ordinaire à côté d'elle. Les entrées relatives et `node_modules/.bin` du `PATH` sont écartées.
    Windows (§9.6) : noms comparés sans tenir compte de la casse, variables système de `WINDOWS_ENV_ALLOWED`,
    `PATH` transmis sous le nom `Path`.
    """
    source = os.environ if source is None else source
    if windows:
        allowed = (ENV_ALLOWED - {"PATH"}) | WINDOWS_ENV_ALLOWED
        env = {k: v for k, v in source.items() if k.upper() in allowed or k.upper().startswith("LC_")}
        raw = next((v for k, v in source.items() if k.upper() == "PATH"), "")
        sep, name = ";", "Path"
        absolute = [p for p in raw.split(sep) if _absolute(p, "win32")]
    else:
        env = {k: v for k, v in source.items() if (k in ENV_ALLOWED and k != "PATH") or k.startswith("LC_")}
        raw, sep, name = source.get("PATH", ""), os.pathsep, "PATH"
        absolute = [p for p in raw.split(sep) if p and os.path.isabs(p)]
    folder = str(Path(executable).parent)
    rest = [p for p in absolute if not _is_node_bin(p)]
    env[name] = sep.join(dict.fromkeys([folder, *rest]))
    env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"
    return env


def _absolute(entry: str, platform: str) -> bool:
    """Entrée de PATH absolue selon `platform` (Windows : `C:\\…`, `\\\\serveur\\…`)."""
    from app import launcher

    return bool(entry) and launcher.is_absolute_path(entry, platform)


class OutputTooLarge(Exception):
    """La CLI a écrit plus que `MAX_OUTPUT_BYTES` : processus arrêté, sortie abandonnée."""

    def __init__(self, limit: int) -> None:
        super().__init__(f"sortie supérieure à {limit} octets")
        self.limit = limit


def _signal_group(proc: subprocess.Popen[bytes], sig: int) -> None:
    """Signal au groupe du processus (enfants compris, ex. `node`) ; à défaut au processus seul."""
    if os.name == "posix":
        with contextlib.suppress(OSError):
            os.killpg(proc.pid, sig)
            return
    with contextlib.suppress(OSError):
        if sig == getattr(signal, "SIGKILL", None):
            proc.kill()
        else:
            proc.terminate()


def _stop(proc: subprocess.Popen[bytes], grace: float) -> None:
    """Arrêt demandé (SIGTERM), puis forcé (SIGKILL) si le processus ne s'arrête pas dans `grace` secondes."""
    _signal_group(proc, signal.SIGTERM)
    try:
        proc.wait(grace)
    except subprocess.TimeoutExpired:
        _signal_group(proc, getattr(signal, "SIGKILL", signal.SIGTERM))
        with contextlib.suppress(subprocess.TimeoutExpired):
            proc.wait(grace)


def run_bounded(
    cmd: Sequence[str],
    *,
    input: str | None = None,  # noqa: A002 — même nom que subprocess.run
    timeout: float,
    cwd: str | None = None,
    env: Mapping[str, str] | None = None,
    max_output: int = MAX_OUTPUT_BYTES,
    grace: float = KILL_GRACE_SECONDS,
) -> subprocess.CompletedProcess[str]:
    """Comme `subprocess.run(capture_output=True, text=True)`, avec une sortie bornée et un arrêt forcé.

    - au-delà de `max_output` octets (stdout + stderr) : processus tué, `OutputTooLarge` ;
    - après `timeout` secondes : SIGTERM, puis SIGKILL après `grace` secondes, `subprocess.TimeoutExpired`.
    Le processus a son propre groupe (POSIX) : ses enfants sont arrêtés avec lui.
    """
    posix = os.name == "posix"
    proc = subprocess.Popen(  # noqa: S603 — exécutable absolu trouvé par find_claude_cli
        list(cmd),
        stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=cwd,
        env=dict(env) if env is not None else None,
        start_new_session=posix,
        creationflags=0 if posix else CREATE_NO_WINDOW,  # Windows : jamais de console (app sans console)
    )
    out, err = bytearray(), bytearray()
    size = [0]
    lock = threading.Lock()
    overflow = threading.Event()

    def pump(stream: IO[bytes], sink: bytearray) -> None:
        with stream:
            while chunk := stream.read1(65536):  # type: ignore[attr-defined]
                if overflow.is_set():
                    continue  # vidange sans conserver, jusqu'à la fermeture du tube
                with lock:
                    if size[0] + len(chunk) <= max_output:
                        size[0] += len(chunk)
                        sink.extend(chunk)
                        continue
                    overflow.set()
                _signal_group(proc, getattr(signal, "SIGKILL", signal.SIGTERM))

    def feed(stream: IO[bytes], data: bytes) -> None:
        with contextlib.suppress(OSError), stream:
            stream.write(data)

    threads = [
        threading.Thread(target=pump, args=(proc.stdout, out), daemon=True),
        threading.Thread(target=pump, args=(proc.stderr, err), daemon=True),
    ]
    if input is not None and proc.stdin is not None:
        threads.append(threading.Thread(target=feed, args=(proc.stdin, input.encode("utf-8")), daemon=True))
    for t in threads:
        t.start()
    deadline = time.monotonic() + timeout
    try:
        proc.wait(timeout)
    except subprocess.TimeoutExpired:
        _stop(proc, grace)
        for t in threads:
            t.join(grace)
        raise subprocess.TimeoutExpired(list(cmd), timeout, bytes(out), bytes(err)) from None
    for t in threads:
        t.join(max(0.0, deadline - time.monotonic()))
    if any(t.is_alive() for t in threads):  # un enfant garde les tubes ouverts : arrêt du groupe
        _signal_group(proc, getattr(signal, "SIGKILL", signal.SIGTERM))
        for t in threads:
            t.join(grace)
    if overflow.is_set():
        raise OutputTooLarge(max_output)
    return subprocess.CompletedProcess(
        list(cmd), proc.returncode, out.decode("utf-8", "replace"), err.decode("utf-8", "replace")
    )


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
        runner: remplaçant de `run_bounded` (tests) ; l'exécutable est alors pris tel quel.
        model_choice: modèle choisi par l'utilisateur (préférences), lu à chaque appel ; None = `model`.
        finder: recherche de l'exécutable (tests) ; par défaut `find_claude_cli(executable)`.
        clock: horloge du cache d'état (tests).
        max_output: taille maximale lue sur les sorties de la CLI, en octets.
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
        max_output: int = MAX_OUTPUT_BYTES,
    ) -> None:
        self.default_model = model
        self.timeout = timeout
        self.max_output = max_output
        self._runner: Runner = runner or run_bounded
        self._model_choice = model_choice
        if finder is None:
            finder = (lambda: executable) if runner is not None else (lambda: find_claude_cli(executable))
        self._finder = finder
        self._clock = clock
        self._path = finder()
        self._found_at = clock()
        self._auth: _AuthState | None = None
        self._forced_at: float | None = None

    @property
    def model(self) -> str:
        """Modèle utilisé pour le prochain appel : choix de l'utilisateur, sinon la configuration."""
        chosen = self._model_choice() if self._model_choice else None
        return chosen or self.default_model

    @property
    def configured(self) -> bool:
        """Vrai si l'exécutable `claude` est trouvé (recherché de nouveau au plus toutes les 60 s s'il manquait)."""
        return self._locate() is not None

    def _locate(self, force: bool = False) -> str | None:
        """Chemin de la CLI ; si elle manquait, nouvelle recherche (forcée, ou après `STATUS_TTL_SECONDS`)."""
        if self._path is None:
            now = self._clock()
            if force or now - self._found_at >= STATUS_TTL_SECONDS:
                self._path = self._finder()
                self._found_at = now
        return self._path

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

    def invalidate(self) -> bool:
        """Oublie l'état en cache (bouton « Revérifier »), au plus une fois toutes les 10 s.

        Retourne False si la demande est ignorée (revérification forcée trop récente) : sans cette limite,
        `?refresh=true` en boucle lancerait `claude auth status` sans fin.
        """
        now = self._clock()
        if self._forced_at is not None and now - self._forced_at < FORCED_REFRESH_SECONDS:
            return False
        self._forced_at = now
        self._auth = None
        self._found_at = float("-inf")  # CLI absente : nouvelle recherche à la prochaine vérification
        return True

    async def _check(self, now: float) -> _AuthState:
        if self._locate(force=True) is None:  # installée depuis le lancement ?
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
        # Le schéma part en argument (visible par `ps`) : sans les énumérations tirées des données.
        public = schema_for_model(schema, keep_data=False)
        payload = await self._ask(messages, system, ["--json-schema", json.dumps(public, ensure_ascii=False)], turns=2)
        structured = payload.get("structured_output")
        if isinstance(structured, dict):
            return structured
        return extract_json("anthropic", str(payload.get("result") or ""))

    async def _ask(
        self, messages: list[ChatMessage], system: str | None, extra: Sequence[str] = (), turns: int = 1
    ) -> dict[str, Any]:
        """Lance `claude -p` isolé et retourne l'objet JSON final (`type: result`).

        `system` ne contient que des consignes (argument visible par `ps`) ; la conversation, avec ses
        données, passe par l'entrée standard.
        """
        if self._locate(force=True) is None:
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
        """Exécute la CLI dans un dossier vide, avec l'environnement en liste blanche et une sortie bornée."""
        path = str(self._path)
        command = cli_command(path)
        if command is None:  # .cmd de npm qui ne se résout pas : jamais lancé par cmd.exe (§9.6)
            raise AIProviderError("anthropic", f"CLI Claude non utilisable ({path}) : installez claude.exe.", 400)
        with tempfile.TemporaryDirectory(prefix="atelier-viz-claude-") as cwd:
            try:
                return await asyncio.to_thread(
                    self._runner,
                    [*command, *args],
                    input=stdin,
                    timeout=timeout,
                    cwd=cwd,
                    env=cli_environment(command[0]),
                    max_output=self.max_output,
                )
            except subprocess.TimeoutExpired as exc:
                raise AIProviderError("anthropic", f"Claude (CLI) n'a pas répondu en {timeout:.0f} s.", 504) from exc
            except OutputTooLarge as exc:
                size = f"{exc.limit // (1024 * 1024)} Mo"
                detail = f"Claude (CLI) : réponse trop volumineuse (plus de {size}), abandonnée."
                raise AIProviderError("anthropic", detail, 502) from exc
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
