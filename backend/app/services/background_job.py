"""Tâche du système qui actualise les sources quand l'application est fermée (`app/background.py`).

| Système | Mécanisme | Fichier |
|---|---|---|
| macOS | Agent launchd de l'utilisateur (`StartInterval`) | `~/Library/LaunchAgents/fr.atelier.viz.refresh.plist` |
| Windows | Planificateur de tâches (`schtasks`, sans droits d'administrateur) | `Atelier Viz - Actualisation` |
| Linux | Minuteur systemd de l'utilisateur | `~/.config/systemd/user/atelier-viz-refresh.{service,timer}` |

- Commandes à arguments fixes (jamais de shell) ; chemins écrits par `plistlib` / échappés pour systemd.
- Lance l'interpréteur de l'application (`sys.executable`, `pythonw.exe` sous Windows : aucune console)
  sur `backend/refresh_once.py`. Le paquet autonome (PyInstaller) ne la propose pas : version figée.
- Rien d'autre n'est installé ; « Désactiver » retire la tâche et ses fichiers.
"""

import plistlib
import subprocess
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path

from pydantic import BaseModel, Field

from app.background import BackgroundStatus

LABEL = "fr.atelier.viz.refresh"
WINDOWS_TASK = "Atelier Viz - Actualisation"
SYSTEMD_UNIT = "atelier-viz-refresh"
MIN_MINUTES, MAX_MINUTES = 5, 1439  # schtasks /SC MINUTE : 1439 au plus

Runner = Callable[[Sequence[str]], subprocess.CompletedProcess[str]]


def default_runner(args: Sequence[str]) -> subprocess.CompletedProcess[str]:
    """Commande à arguments fixes, sans shell, bornée à 30 s."""
    return subprocess.run(list(args), capture_output=True, text=True, timeout=30, check=False)  # noqa: S603


class BackgroundJobError(Exception):
    def __init__(self, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


class BackgroundJobInput(BaseModel):
    enabled: bool
    interval_minutes: int = Field(default=15, ge=MIN_MINUTES, le=MAX_MINUTES)


class BackgroundJobState(BaseModel):
    supported: bool
    platform: str
    reason: str | None = Field(default=None, description="Pourquoi la tâche n'est pas proposée.")
    installed: bool = False
    interval_minutes: int | None = None
    location: str | None = Field(default=None, description="Fichier ou nom de la tâche installée.")
    last: BackgroundStatus = Field(default_factory=BackgroundStatus)


@dataclass
class Environment:
    """Ce dont dépend l'installation (remplaçable en test)."""

    platform: str
    home: Path
    python: Path
    entry: Path
    frozen: bool = False
    runner: Runner = default_runner


def current_environment() -> Environment:
    python = Path(sys.executable)
    if sys.platform == "win32" and python.name.lower() == "python.exe":
        windowless = python.with_name("pythonw.exe")
        python = windowless if windowless.exists() else python
    return Environment(
        platform=sys.platform,
        home=Path.home(),
        python=python,
        entry=Path(__file__).resolve().parents[2] / "refresh_once.py",
        frozen=bool(getattr(sys, "frozen", False)),
    )


BOOTSTRAP_RETRIES = 5


def _sleep(seconds: float) -> None:
    """Attente entre deux essais de `launchctl bootstrap` (remplacée dans les tests)."""
    import time

    time.sleep(seconds)


def _systemd_quote(path: Path) -> str:
    """Chemin pour `ExecStart=` : entre guillemets, `\\`, `"`, `%` et `$` échappés."""
    s = str(path).replace("\\", "\\\\").replace('"', '\\"').replace("%", "%%").replace("$", "$$")
    return f'"{s}"'


class BackgroundJob:
    """Installe, lit et retire la tâche du système."""

    def __init__(self, env: Environment, status: Callable[[], BackgroundStatus]) -> None:
        self.env = env
        self.status = status

    # --- Emplacements ------------------------------------------------------------------------------

    @property
    def _plist(self) -> Path:
        return self.env.home / "Library" / "LaunchAgents" / f"{LABEL}.plist"

    @property
    def _units(self) -> tuple[Path, Path]:
        base = self.env.home / ".config" / "systemd" / "user"
        return base / f"{SYSTEMD_UNIT}.service", base / f"{SYSTEMD_UNIT}.timer"

    def _kind(self) -> str | None:
        p = self.env.platform
        return (
            "launchd" if p == "darwin" else "schtasks" if p == "win32" else "systemd" if p.startswith("linux") else None
        )

    # --- État --------------------------------------------------------------------------------------

    def state(self) -> BackgroundJobState:
        kind = self._kind()
        base = BackgroundJobState(supported=False, platform=self.env.platform, last=self.status())
        if self.env.frozen:
            return base.model_copy(
                update={"reason": "Version autonome : utilisez l'application installée depuis le dépôt."}
            )
        if kind is None:
            return base.model_copy(update={"reason": "Système non pris en charge."})
        if not self.env.entry.exists():
            return base.model_copy(update={"reason": "Script d'actualisation introuvable (refresh_once.py)."})
        out = base.model_copy(update={"supported": True})
        if kind == "launchd" and self._plist.exists():
            try:
                data = plistlib.loads(self._plist.read_bytes())
                minutes = int(data.get("StartInterval", 0)) // 60 or None
            except (plistlib.InvalidFileException, ValueError, TypeError):
                minutes = None
            return out.model_copy(update={"installed": True, "interval_minutes": minutes, "location": str(self._plist)})
        if kind == "systemd" and self._units[1].exists():
            text = self._units[1].read_text(encoding="utf-8")
            minutes = next(
                (
                    int(line.split("=")[1].rstrip("min"))
                    for line in text.splitlines()
                    if line.startswith("OnUnitActiveSec=")
                ),
                None,
            )
            return out.model_copy(
                update={"installed": True, "interval_minutes": minutes, "location": str(self._units[1])}
            )
        if kind == "schtasks":
            res = self.env.runner(["schtasks", "/Query", "/TN", WINDOWS_TASK, "/XML"])
            if res.returncode == 0:
                minutes = None
                marker = "<Interval>PT"
                if marker in res.stdout:
                    raw = res.stdout.split(marker, 1)[1].split("<", 1)[0]
                    minutes = int(raw[:-1]) * (60 if raw.endswith("H") else 1) if raw[:-1].isdigit() else None
                return out.model_copy(update={"installed": True, "interval_minutes": minutes, "location": WINDOWS_TASK})
        return out

    # --- Installation ------------------------------------------------------------------------------

    def apply(self, body: BackgroundJobInput) -> BackgroundJobState:
        current = self.state()
        if not current.supported:
            raise BackgroundJobError(current.reason or "Non pris en charge.", 409)
        kind = self._kind()
        if kind == "launchd":
            self._launchd(body)
        elif kind == "systemd":
            self._systemd(body)
        else:
            self._schtasks(body)
        return self.state()

    def _check(self, res: subprocess.CompletedProcess[str], what: str) -> None:
        if res.returncode != 0:
            detail = (res.stderr or res.stdout or "").strip().splitlines()[-1:] or [""]
            raise BackgroundJobError(f"{what} : {detail[0][:200]}", 502)

    def _launchd(self, body: BackgroundJobInput) -> None:
        domain = f"gui/{_uid()}"
        if self._plist.exists():
            self.env.runner(["launchctl", "bootout", domain, str(self._plist)])  # absent : sans importance
            if not body.enabled:
                self._plist.unlink(missing_ok=True)
                return
        if not body.enabled:
            return
        self._plist.parent.mkdir(parents=True, exist_ok=True)
        plist = {
            "Label": LABEL,
            "ProgramArguments": [str(self.env.python), str(self.env.entry)],
            "WorkingDirectory": str(self.env.entry.parent),
            "StartInterval": body.interval_minutes * 60,
            "RunAtLoad": False,
            "ProcessType": "Background",
            "LowPriorityIO": True,
            "StandardOutPath": str(self.env.home / "Library" / "Logs" / "Atelier Viz" / "actualisation.log"),
            "StandardErrorPath": str(self.env.home / "Library" / "Logs" / "Atelier Viz" / "actualisation.log"),
        }
        (self.env.home / "Library" / "Logs" / "Atelier Viz").mkdir(parents=True, exist_ok=True)
        self._plist.write_bytes(plistlib.dumps(plist))
        # Juste après un `bootout`, launchd répond souvent « 5: Input/output error » : on réessaie, et un
        # agent qui n'a pas pu être chargé est retiré (sinon l'état le dirait installé alors qu'il ne tourne pas).
        res = self.env.runner(["launchctl", "bootstrap", domain, str(self._plist)])
        for _ in range(BOOTSTRAP_RETRIES):
            if res.returncode == 0:
                break
            _sleep(0.5)
            res = self.env.runner(["launchctl", "bootstrap", domain, str(self._plist)])
        if res.returncode != 0:
            self._plist.unlink(missing_ok=True)
        self._check(res, "launchctl")

    def _systemd(self, body: BackgroundJobInput) -> None:
        service, timer = self._units
        if not body.enabled:
            self.env.runner(["systemctl", "--user", "disable", "--now", f"{SYSTEMD_UNIT}.timer"])
            service.unlink(missing_ok=True)
            timer.unlink(missing_ok=True)
            self.env.runner(["systemctl", "--user", "daemon-reload"])
            return
        service.parent.mkdir(parents=True, exist_ok=True)
        service.write_text(
            "[Unit]\nDescription=Atelier Viz : actualisation des sources (application fermée)\n\n"
            "[Service]\nType=oneshot\n"
            f"ExecStart={_systemd_quote(self.env.python)} {_systemd_quote(self.env.entry)}\n"
            "Nice=10\n",
            encoding="utf-8",
        )
        timer.write_text(
            "[Unit]\nDescription=Atelier Viz : minuteur d'actualisation\n\n"
            f"[Timer]\nOnBootSec=5min\nOnUnitActiveSec={body.interval_minutes}min\nPersistent=true\n\n"
            "[Install]\nWantedBy=timers.target\n",
            encoding="utf-8",
        )
        self._check(self.env.runner(["systemctl", "--user", "daemon-reload"]), "systemctl")
        self._check(self.env.runner(["systemctl", "--user", "enable", "--now", f"{SYSTEMD_UNIT}.timer"]), "systemctl")

    def _schtasks(self, body: BackgroundJobInput) -> None:
        if not body.enabled:
            self.env.runner(["schtasks", "/Delete", "/TN", WINDOWS_TASK, "/F"])
            return
        # /TR : une seule chaîne ; chemins entre guillemets (espaces, accents). Pas de cmd.exe.
        command = f'"{self.env.python}" "{self.env.entry}"'
        if '"' in str(self.env.python) + str(self.env.entry):
            raise BackgroundJobError("Chemin d'installation invalide (guillemet).")
        args = [
            "schtasks",
            "/Create",
            "/F",
            "/TN",
            WINDOWS_TASK,
            "/SC",
            "MINUTE",
            "/MO",
            str(body.interval_minutes),
            "/TR",
            command,
        ]
        self._check(self.env.runner(args), "schtasks")


def _uid() -> int:
    import os

    return os.getuid() if hasattr(os, "getuid") else 0
