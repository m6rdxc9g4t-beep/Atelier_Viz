"""Ouverture d'une autre app de la suite (docs/SUITE.md §3, §9.4) : environnement minimal, macOS `open -b`,
Windows lanceur lu dans `HKCU\\Software\\Atelier\\Apps\\<app>`. Aucun programme réel n'est lancé (exécutants simulés),
sauf l'aller-retour réel dans le registre sous Windows.
"""

from __future__ import annotations

import os
import subprocess
import sys
import uuid
from pathlib import Path
from typing import Any

import pytest

from app import desktop, launcher, suite_apps

windows_only = pytest.mark.skipif(sys.platform != "win32", reason="Windows seulement")

INHERITED = {
    "HOME": "/Users/francois",
    "USER": "francois",
    "LANG": "fr_FR.UTF-8",
    "LC_ALL": "fr_FR.UTF-8",
    "TZ": "Europe/Paris",
    "TMPDIR": "/tmp/x",
    "USERPROFILE": r"C:\Users\François",
    "LOCALAPPDATA": r"C:\Users\François\AppData\Local",
    "SystemRoot": r"C:\Windows",
    # Propres à Viz ou à une autre app : jamais transmises.
    "PATH": "/repo/frontend/node_modules/.bin:/venv/bin:/usr/bin",
    "DATA_DIR": "/repo/backend/data",
    "DATABASE_URL": "file:./dev.db",
    "PORT": "8000",
    "NEXUS_TOKEN": "x",
    "ATELIER_PROJETS_URL": "http://127.0.0.1:3000",
    "ELECTRON_RUN_AS_NODE": "1",
    "PYTHONPATH": "/repo/backend",
    "VIRTUAL_ENV": "/venv",
    "NODE_ENV": "production",
    "ANTHROPIC_API_KEY": "secret",
    "GITHUB_TOKEN": "secret",
}


def test_minimal_environment_keeps_only_the_whitelist() -> None:
    env = suite_apps.minimal_env(INHERITED, "darwin")
    assert env == {
        "HOME": "/Users/francois",
        "USER": "francois",
        "LANG": "fr_FR.UTF-8",
        "LC_ALL": "fr_FR.UTF-8",
        "TZ": "Europe/Paris",
        "TMPDIR": "/tmp/x",
        "USERPROFILE": r"C:\Users\François",
        "LOCALAPPDATA": r"C:\Users\François\AppData\Local",
        "SystemRoot": r"C:\Windows",
        "PATH": suite_apps.POSIX_SYSTEM_PATH,
    }
    # Windows : PATH de la session lu dans le registre (sans les ajouts des apps), sinon les dossiers de Windows.
    win = suite_apps.minimal_env(INHERITED, "win32", registry=lambda: r"C:\Windows\system32;C:\Program Files\Git\cmd")
    assert win["PATH"] == r"C:\Windows\system32;C:\Program Files\Git\cmd"
    fallback = suite_apps.minimal_env({"SystemRoot": r"D:\Win"}, "win32", registry=lambda: None)
    assert fallback["PATH"].lower().split(";")[0].endswith(r"\system32")


def test_macos_opens_the_bundle_with_the_minimal_environment() -> None:
    calls: list[tuple[list[str], dict[str, Any]]] = []

    def run(cmd: list[str], **kwargs: Any) -> subprocess.CompletedProcess[bytes]:
        calls.append((cmd, kwargs))
        return subprocess.CompletedProcess(cmd, 0)

    assert suite_apps.open_macos_app("fr.atelier.tab", run=run, platform="darwin") is True
    cmd, kwargs = calls[0]
    assert cmd == ["/usr/bin/open", "-b", "fr.atelier.tab"]
    assert kwargs["env"]["PATH"] == suite_apps.POSIX_SYSTEM_PATH
    assert not {"DATA_DIR", "PYTHONPATH", "NODE_ENV", "VIRTUAL_ENV"} & set(kwargs["env"])
    assert suite_apps.open_macos_app("fr.atelier.tab", run=run, platform="win32") is False


def test_registry_launcher_values_are_validated(tmp_path: Path) -> None:
    present = {Path(r"C:\Users\François\AppData\Local\Atelier_Tab\Atelier Tab.lnk"), Path(r"C:\Apps\Tab\tab.exe")}

    def exists(path: Path) -> bool:
        return path in present

    lnk = r"C:\Users\François\AppData\Local\Atelier_Tab\Atelier Tab.lnk"
    assert suite_apps.valid_launcher(lnk, exists) == Path(lnk)
    assert suite_apps.valid_launcher(f'"{lnk}"', exists) == Path(lnk)  # guillemets tolérés
    assert suite_apps.valid_launcher(r"C:\Apps\Tab\tab.exe", exists) == Path(r"C:\Apps\Tab\tab.exe")
    for bad in (None, 3, "", r"Atelier Tab.lnk", r"\Apps\tab.exe", r"C:\Apps\absent.exe", r"C:\Apps\Tab\script.ps1"):
        assert suite_apps.valid_launcher(bad, exists) is None


class FakeProcess:
    def __init__(self, code: int = 0) -> None:
        self.code = code

    def wait(self, timeout: float | None = None) -> int:
        return self.code


def test_windows_starts_the_registered_launcher_with_a_clean_environment() -> None:
    spawned: list[dict[str, Any]] = []

    def spawn(cmd: list[str], **kwargs: Any) -> FakeProcess:
        spawned.append({"cmd": cmd, **kwargs})
        return FakeProcess(0)

    clean = {"USERPROFILE": r"C:\Users\François", "PATH": r"C:\Windows\system32"}
    exe = Path(r"C:\Program Files\Atelier Tab\Atelier Tab.exe")
    assert suite_apps.open_windows_app("tab", read=lambda app: exe, spawn=spawn, env=clean, frozen=False)
    assert spawned[0]["cmd"] == [str(exe)] and spawned[0]["env"] == clean and spawned[0]["cwd"] == str(exe.parent)
    assert spawned[0]["flags"] & suite_apps.DETACHED_PROCESS

    # Raccourci : relais Python sans console, chemin en argument (jamais dans une ligne interprétée).
    lnk = Path(r"C:\Users\François\AppData\Local\Atelier_Projets\Atelier Projets & Co.lnk")
    assert suite_apps.open_windows_app(
        "projets", read=lambda app: lnk, spawn=spawn, env=clean, python=r"C:\venv\pythonw.exe", frozen=False
    )
    relay = spawned[1]
    assert relay["cmd"][:4] == [r"C:\venv\pythonw.exe", "-I", "-S", "-c"] and relay["cmd"][-1] == str(lnk)
    assert relay["env"] == clean and relay["flags"] == launcher.CREATE_NO_WINDOW
    # Le relais échoue (fichier introuvable…) : False, donc navigateur.
    failing = suite_apps.open_windows_app(
        "projets", read=lambda app: lnk, spawn=lambda cmd, **kw: FakeProcess(1), env=clean, frozen=False
    )
    assert failing is False
    # Paquet autonome : ouverture directe par le shell.
    opened: list[str] = []
    assert suite_apps.open_windows_app(
        "projets", read=lambda app: lnk, frozen=True, shell_open=opened.append, env=clean
    )
    assert opened == [str(lnk)]
    # Pas d'app enregistrée, ou lancement impossible : False.
    assert suite_apps.open_windows_app("tab", read=lambda app: None, spawn=spawn) is False

    def broken(cmd: list[str], **kwargs: Any) -> FakeProcess:
        raise OSError("introuvable")

    assert suite_apps.open_windows_app("tab", read=lambda app: exe, spawn=broken, env=clean) is False


def test_suite_app_ids_and_dispatch(monkeypatch: pytest.MonkeyPatch) -> None:
    opened: list[str] = []
    monkeypatch.setattr(suite_apps, "open_windows_app", lambda app_id: opened.append(app_id) or True)
    monkeypatch.setattr(suite_apps, "open_macos_app", lambda bundle: opened.append(bundle) or True)
    assert suite_apps.open_suite_app("fr.atelier.tab", "win32") and opened == ["tab"]
    assert suite_apps.open_suite_app("local.atelier-projets.desktop", "win32") and opened[-1] == "projets"
    assert suite_apps.open_suite_app("fr.ateliercuisine.app", "win32") is False  # app en ligne : navigateur
    assert suite_apps.open_suite_app("fr.atelier.tab", "darwin") and opened[-1] == "fr.atelier.tab"
    assert suite_apps.open_suite_app("fr.atelier.tab", "linux") is False
    # Chaque app locale de la suite connue de macOS a son nom Windows (§9.4).
    assert set(suite_apps.WINDOWS_APP_IDS) == {b for b in desktop.SUITE_BUNDLES.values()}
    assert set(suite_apps.WINDOWS_APP_IDS.values()) == {"viz", "tab", "projets"}


@windows_only
def test_windows_registry_round_trip() -> None:
    """Aller-retour réel dans HKCU (clé de test à part, supprimée ensuite)."""
    import winreg

    root = rf"Software\Atelier\Tests-{uuid.uuid4().hex}"
    target = Path(sys.executable)
    try:
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, rf"{root}\tab") as key:
            winreg.SetValueEx(key, "Lanceur", 0, winreg.REG_SZ, str(target))
            winreg.SetValueEx(key, "Nom", 0, winreg.REG_SZ, "Atelier Tab")
        assert suite_apps.registry_launcher("tab", root=root) == target
        assert suite_apps.registry_launcher("projets", root=root) is None
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, rf"{root}\nexus") as key:
            winreg.SetValueEx(key, "Lanceur", 0, winreg.REG_EXPAND_SZ, r"%SystemRoot%\System32\notepad.exe")
        assert (
            suite_apps.registry_launcher("nexus", root=root)
            == Path(os.environ["SystemRoot"]) / "System32" / "notepad.exe"
        )
    finally:
        for sub in ("tab", "nexus", ""):
            try:
                winreg.DeleteKey(winreg.HKEY_CURRENT_USER, rf"{root}\{sub}".rstrip("\\"))
            except OSError:
                pass
