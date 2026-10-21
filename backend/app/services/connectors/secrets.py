"""Stockage des secrets des connexions (mots de passe, jetons Microsoft).

Par défaut : trousseau du système (Trousseau macOS, Gestionnaire d'identifiants Windows,
Secret Service sous Linux) via `keyring`. Sans trousseau disponible : fichier
`data/secrets.json` lisible par le seul utilisateur (droits 0600 sous macOS / Linux ; sous Windows,
où ces droits n'existent pas, le Gestionnaire d'identifiants est toujours disponible et le repli
fichier n'est utilisé que si on le force : `SECRETS_BACKEND=file`).
Les secrets ne sont jamais renvoyés par l'API ni écrits dans `connections.json`.
"""

import json
import os
import threading
from pathlib import Path
from typing import Literal, Protocol

from app.core.files import replace_file

SERVICE = "atelier-viz"


class SecretBackend(Protocol):
    def get(self, key: str) -> str | None: ...
    def set(self, key: str, value: str) -> None: ...
    def delete(self, key: str) -> None: ...


class FileSecrets:
    """Secrets dans un fichier JSON en 0600 (repli sans trousseau)."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()

    def _read(self) -> dict[str, str]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return {}
        return {str(k): str(v) for k, v in data.items()} if isinstance(data, dict) else {}

    def _write(self, data: dict[str, str]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f)
        replace_file(tmp, self.path)
        os.chmod(self.path, 0o600)

    def get(self, key: str) -> str | None:
        with self._lock:
            return self._read().get(key)

    def set(self, key: str, value: str) -> None:
        with self._lock:
            data = self._read()
            data[key] = value
            self._write(data)

    def delete(self, key: str) -> None:
        with self._lock:
            data = self._read()
            if data.pop(key, None) is not None:
                self._write(data)


class KeyringSecrets:
    """Secrets dans le trousseau du système."""

    def __init__(self) -> None:
        import keyring

        self._keyring = keyring

    def get(self, key: str) -> str | None:
        value: str | None = self._keyring.get_password(SERVICE, key)
        return value

    def set(self, key: str, value: str) -> None:
        self._keyring.set_password(SERVICE, key, value)

    def delete(self, key: str) -> None:
        try:
            self._keyring.delete_password(SERVICE, key)
        except self._keyring.errors.PasswordDeleteError:
            pass


def _keyring_usable() -> bool:
    try:
        import keyring
        from keyring.backends import fail
    except ImportError:
        return False
    backend = keyring.get_keyring()
    # Pas de trousseau réel (serveur sans session graphique, conteneur…) : repli sur le fichier.
    return not isinstance(backend, fail.Keyring) and "null" not in type(backend).__module__.lower()


def build_secrets(backend: Literal["auto", "keyring", "file"], path: Path) -> SecretBackend:
    """Trousseau si disponible (`auto`), sinon fichier 0600."""
    if backend == "keyring" or (backend == "auto" and _keyring_usable()):
        try:
            return KeyringSecrets()
        except Exception:  # noqa: BLE001 — trousseau inutilisable : repli fichier
            pass
    return FileSecrets(path)
