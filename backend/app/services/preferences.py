"""Préférences modifiables depuis l'interface (data/settings.json)."""

import threading
from pathlib import Path

from pydantic import BaseModel


class Preferences(BaseModel):
    """Réglages utilisateur persistants.

    online_mode : False = tout reste sur la machine (Ollama seulement, webhooks locaux seulement).
                  True  = Claude (CLI ou API) et webhooks vers Internet autorisés.
    """

    online_mode: bool = False


class PreferencesStore:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()
        self._value = self._load()

    def _load(self) -> Preferences:
        if self.path.exists():
            try:
                return Preferences.model_validate_json(self.path.read_text(encoding="utf-8"))
            except ValueError:
                pass
        return Preferences()

    def get(self) -> Preferences:
        return self._value

    def set(self, value: Preferences) -> Preferences:
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self.path.write_text(value.model_dump_json(indent=2), encoding="utf-8")
            self._value = value
        return value
