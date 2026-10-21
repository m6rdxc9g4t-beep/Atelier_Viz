"""Version Windows : remplacement de fichiers, CLI Claude, notifications, lanceur (testés sur tous les systèmes)."""

import base64
import io
import json
import os
import subprocess
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from app import desktop, launcher, windows_launcher
from app.core.files import replace_file
from app.services import system_notify
from app.services.ai.claude_cli import (
    ENV_ALLOWED_WINDOWS,
    WINDOWS_FALLBACK_DIRS,
    cli_environment,
    find_claude_cli,
    npm_native_executable,
)

ROOT = Path(__file__).resolve().parents[2]

# --- Remplacement atomique (fichier tenu ouvert un instant sous Windows) ----------------------------


def test_replace_file_retries_transient_permission_errors(tmp_path: Path) -> None:
    calls: list[tuple[Any, Any]] = []
    pauses: list[float] = []

    def flaky(src: Any, dst: Any) -> None:
        calls.append((src, dst))
        if len(calls) < 3:
            raise PermissionError(13, "fichier utilisé par un autre processus")
        os.replace(src, dst)

    src, dst = tmp_path / "a.tmp", tmp_path / "a.json"
    src.write_text("{}", encoding="utf-8")
    replace_file(src, dst, attempts=5, pause=0.01, replace=flaky, sleep=pauses.append)
    assert dst.read_text(encoding="utf-8") == "{}" and len(calls) == 3 and pauses == [0.01, 0.01]


def test_replace_file_gives_up_after_the_last_attempt(tmp_path: Path) -> None:
    def locked(src: Any, dst: Any) -> None:
        raise PermissionError(13, "verrouillé")

    with pytest.raises(PermissionError):
        replace_file(tmp_path / "a", tmp_path / "b", attempts=3, replace=locked, sleep=lambda _: None)
    # Les autres erreurs ne sont jamais réessayées.
    with pytest.raises(FileNotFoundError):
        replace_file(tmp_path / "absent", tmp_path / "b", attempts=3, sleep=lambda _: None)


# --- CLI Claude sous Windows ------------------------------------------------------------------------


def _file(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"MZ")
    return path


def test_windows_search_runs_only_claude_exe(tmp_path: Path) -> None:
    """Dans le PATH : `claude.exe` ; un `claude.cmd` sans binaire natif à côté n'est jamais lancé."""
    shim_only = tmp_path / "shims"
    _file(shim_only / "claude.cmd")
    native = _file(tmp_path / "bin" / "claude.exe")
    env = {"Path": os.pathsep.join([str(shim_only), str(native.parent)])}  # casse de Windows
    assert find_claude_cli("claude", env=env, fallback_dirs=(), windows=True) == str(native)
    assert find_claude_cli("claude", env={"PATH": str(shim_only)}, fallback_dirs=(), windows=True) is None


def test_npm_shim_resolves_to_the_packaged_binary(tmp_path: Path) -> None:
    """`npm install -g` : `%APPDATA%\\npm\\claude.cmd` → `claude.exe` du paquet (jamais le .cmd lui-même)."""
    npm = tmp_path / "npm"
    shim = _file(npm / "claude.cmd")
    assert npm_native_executable(shim) is None
    exe = _file(npm / "node_modules" / "@anthropic-ai" / "claude-code" / "bin" / "claude.exe")
    assert npm_native_executable(shim) == exe
    assert find_claude_cli("claude", env={"PATH": str(npm)}, fallback_dirs=(), windows=True) == str(exe)
    # Paquet de plateforme (dépendance facultative) quand le paquet principal ne contient pas le binaire.
    exe.unlink()
    platform = _file(npm / "node_modules" / "@anthropic-ai" / "claude-code-win32-x64" / "claude.exe")
    assert npm_native_executable(shim) == platform


def test_windows_fallback_dirs_expand_variables(tmp_path: Path) -> None:
    """Application lancée par le raccourci : WinGet / npm trouvés par `%LOCALAPPDATA%` et `%APPDATA%`."""
    assert WINDOWS_FALLBACK_DIRS[0] == "~/.local/bin"
    links = _file(tmp_path / "local" / "Microsoft" / "WinGet" / "Links" / "claude.exe")
    env = {"LocalAppData": str(tmp_path / "local")}
    assert find_claude_cli("claude", env=env, windows=True) == str(links)
    # Variable absente : dossier ignoré, sans erreur.
    assert find_claude_cli("claude", env={}, fallback_dirs=("%ABSENTE%/bin",), windows=True) is None


def test_windows_configured_cmd_is_replaced_by_its_binary(tmp_path: Path) -> None:
    npm = tmp_path / "npm"
    shim = _file(npm / "claude.cmd")
    exe = _file(npm / "node_modules" / "@anthropic-ai" / "claude-code" / "claude.exe")
    assert find_claude_cli(str(shim), env={}, fallback_dirs=(), windows=True) == str(exe)
    script = _file(tmp_path / "autre" / "claude.ps1")
    assert find_claude_cli(str(script), env={}, fallback_dirs=(), windows=True) is None


def test_windows_cli_environment_keeps_system_variables_only() -> None:
    source = {
        "Path": r"C:\Windows\System32;relatif;C:\p\node_modules\.bin;C:\Users\moi\.local\bin",
        "SystemRoot": r"C:\Windows",
        "TEMP": r"C:\Users\moi\AppData\Local\Temp",
        "USERPROFILE": r"C:\Users\moi",
        "APPDATA": r"C:\Users\moi\AppData\Roaming",
        "LOCALAPPDATA": r"C:\Users\moi\AppData\Local",
        "ANTHROPIC_API_KEY": "sk-secret",
        "GITHUB_TOKEN": "ghp_secret",
        "CLAUDE_CODE_USE_BEDROCK": "1",
        "NODE_OPTIONS": "--require evil.js",
    }
    env = cli_environment(r"C:\Users\moi\.local\bin\claude.exe", source, windows=True)
    assert set(env) == {
        "SystemRoot", "TEMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
        "PATH", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    }  # fmt: skip
    assert env["PATH"].split(";") == [r"C:\Users\moi\.local\bin", r"C:\Windows\System32"]
    assert all(name.isupper() for name in ENV_ALLOWED_WINDOWS)


def test_windows_tree_kill_is_used_when_not_posix(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services.ai import claude_cli

    killed: list[int] = []
    monkeypatch.setattr(claude_cli, "os", SimpleNamespace(name="nt"))  # ce module seulement
    monkeypatch.setattr(claude_cli, "_kill_tree_windows", lambda pid: killed.append(pid) or True)

    class Proc:
        pid = 4242

        def poll(self) -> None:
            return None

        def kill(self) -> None:  # pragma: no cover — remplacé par taskkill
            raise AssertionError("taskkill attendu")

        terminate = kill

    claude_cli._signal_group(Proc(), 15)  # type: ignore[arg-type]
    assert killed == [4242]


# --- Notifications Windows ----------------------------------------------------------------------


def test_windows_toast_script_is_constant_and_text_goes_through_env(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    exe = _file(tmp_path / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe")
    monkeypatch.setenv("SYSTEMROOT", str(tmp_path))
    assert system_notify.windows_powershell() == str(exe)
    seen: list[dict[str, Any]] = []
    monkeypatch.setattr(system_notify.subprocess, "run", lambda args, **kw: seen.append({"args": args, **kw}))
    notifier = system_notify.system_notifier("win32")
    assert notifier is not None
    notifier("Seuil franchi\x07", "CA < 1 000 € ; $(Remove-Item C:\\) '\"")
    call = seen[0]
    assert call["args"] == system_notify.windows_toast_command(str(exe))  # aucune donnée dans la commande
    assert call["env"]["ATELIER_NOTIFY_TITLE"] == "Seuil franchi"
    assert call["env"]["ATELIER_NOTIFY_MESSAGE"].startswith("CA < 1 000 €")
    script = base64.b64decode(call["args"][-1]).decode("utf-16-le")
    assert "$env:ATELIER_NOTIFY_MESSAGE" in script and "CreateTextNode" in script


def test_windows_notifier_absent_without_powershell(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("SYSTEMROOT", str(tmp_path / "vide"))
    monkeypatch.delenv("SystemRoot", raising=False)
    monkeypatch.delenv("WINDIR", raising=False)
    assert system_notify.system_notifier("win32") is None


# --- Application de bureau ----------------------------------------------------------------------


def test_lock_errors_are_recognized_on_every_system() -> None:
    assert desktop.lock_error('IO Error: Could not set lock on file "atelier.duckdb": Conflicting lock')
    assert desktop.lock_error(
        "Cannot open file: The process cannot access the file because it is being used by another process."
    )  # noqa: E501
    assert desktop.lock_error(
        "Le processus ne peut pas accéder au fichier car ce fichier est utilisé par un autre processus."
    )  # noqa: E501
    assert not desktop.lock_error("Catalog Error: Table with name x does not exist")


def test_log_location_and_build_script_follow_the_system() -> None:
    env = {"LOCALAPPDATA": r"C:\Users\moi\AppData\Local"}
    assert launcher.log_dir("win32", env) == Path(r"C:\Users\moi\AppData\Local") / "Atelier Viz" / "Logs"
    assert launcher.log_hint("win32") == r"%LOCALAPPDATA%\Atelier Viz\Logs\atelier-viz.log"
    assert launcher.log_hint("darwin") == "~/Library/Logs/Atelier Viz/atelier-viz.log"
    assert launcher.build_script("win32") == "scripts/windows/build_app.ps1"
    assert launcher.build_script("darwin") == "scripts/macos/build_app.sh"
    assert (ROOT / launcher.build_script("win32")).is_file() and (ROOT / launcher.build_script("darwin")).is_file()


# --- Lanceur Windows ----------------------------------------------------------------------------


def test_saved_path_is_merged_first_without_duplicates() -> None:
    saved = os.pathsep.join([str(Path("/conda/env/Library/bin").resolve()), str(Path("/usr/bin").resolve()), "relatif"])
    current = os.pathsep.join([str(Path("/usr/bin").resolve()) + os.sep, str(Path("/opt/x").resolve())])
    merged = windows_launcher.merged_path(current, saved).split(os.pathsep)
    assert merged == [str(Path(p).resolve()) for p in ("/conda/env/Library/bin", "/usr/bin", "/opt/x")]


def test_config_is_read_with_or_without_bom(tmp_path: Path) -> None:
    path = tmp_path / "launcher.json"
    path.write_bytes(b"\xef\xbb\xbf" + json.dumps({"path": "C:\\x"}).encode())
    assert windows_launcher.read_config(path) == {"path": "C:\\x"}
    path.write_text("pas du json", encoding="utf-8")
    assert windows_launcher.read_config(path) == {}
    assert windows_launcher.read_config(tmp_path / "absent.json") == {}
    assert windows_launcher.config_path({"LOCALAPPDATA": str(tmp_path)}) == tmp_path / "Atelier Viz" / "launcher.json"


def test_log_is_rotated_beyond_its_limit(tmp_path: Path) -> None:
    log = tmp_path / "atelier-viz.log"
    log.write_text("x" * 20, encoding="utf-8")
    windows_launcher.rotate_log(log, limit=10)
    assert not log.exists() and (tmp_path / "atelier-viz.log.1").read_text(encoding="utf-8") == "x" * 20
    windows_launcher.rotate_log(log, limit=10)  # absent : rien à faire


@pytest.mark.parametrize(
    ("action", "npm", "code", "ran", "alerted"),
    [
        ("ok", "npm.cmd", 0, False, False),
        ("build", "npm.cmd", 0, True, False),
        ("build", "npm.cmd", 1, True, True),
        ("build", None, 0, False, True),
        ("install", "npm.cmd", 0, False, True),
    ],
)
def test_interface_update_never_installs_packages(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    action: str,
    npm: str | None,
    code: int,
    ran: bool,
    alerted: bool,
) -> None:
    front = tmp_path / "frontend"
    (front / "dist").mkdir(parents=True)
    (front / "dist" / "index.html").write_text("<div id=root>", encoding="utf-8")
    monkeypatch.setattr(windows_launcher, "interface_action", lambda _: action)
    runs: list[list[str]] = []
    alerts: list[str] = []

    def run(args: list[str], **kwargs: Any) -> subprocess.CompletedProcess[str]:
        runs.append(args)
        assert kwargs["creationflags"] == windows_launcher.CREATE_NO_WINDOW and kwargs["cwd"] == str(front)
        return subprocess.CompletedProcess(args, code)

    result = windows_launcher.update_interface(front, io.StringIO(), alerts.append, run=run, which=lambda _: npm)
    assert result == action
    assert runs == ([["npm.cmd", "run", "build", "--silent"]] if ran else [])
    assert bool(alerts) is alerted
    assert all("build_app.ps1" in text for text in alerts)


def test_windows_scripts_are_present_and_encoded_for_powershell_5() -> None:
    folder = ROOT / "scripts" / "windows"
    script = (folder / "build_app.ps1").read_bytes()
    assert script.startswith(b"\xef\xbb\xbf")  # UTF-8 avec BOM : sinon Windows PowerShell 5.1 lit de l'ANSI
    text = script.decode("utf-8-sig")
    assert "-m app.windows_launcher" in text and "-X utf8" in text and "pythonw.exe" in text
    assert "build_app.ps1" in (folder / "build_app.cmd").read_text(encoding="ascii")
    assert (folder / "icon.ico").read_bytes()[:4] == b"\x00\x00\x01\x00"  # en-tête ICO
    assert desktop.ICON.name in {"icon.ico", "icon.png"} and desktop.ICON.is_file()
