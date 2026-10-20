"""Préférences modifiables depuis l'interface (data/settings.json)."""

import os
import threading
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.schemas.ai import ProviderChoice

ClaudeModel = Literal["sonnet", "opus", "haiku"]
"""Modèles Claude proposés à l'utilisateur (alias de la CLI, docs/SUITE.md §5.2)."""


class Preferences(BaseModel):
    """Réglages utilisateur persistants.

    online_mode : False = tout reste sur la machine (Ollama seulement, webhooks locaux seulement).
                  True  = Claude (CLI ou API) et webhooks vers Internet autorisés.
    ai_provider : moteur choisi (« Auto · Ollama · Claude »), partagé par tous les écrans d'IA.
    claude_model : modèle Claude de la CLI (Sonnet par défaut).
    ollama_model : modèle Ollama choisi ; None = `OLLAMA_MODEL` de la configuration.
    """

    online_mode: bool = False
    ai_provider: ProviderChoice = "auto"
    claude_model: ClaudeModel = "sonnet"
    ollama_model: str | None = Field(default=None, min_length=1, max_length=200)


class PreferencesStore:
    """Préférences en mémoire et sur disque ; toute modification (fusion comprise) se fait sous un même verrou."""

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
        """Remplace toutes les préférences."""
        with self._lock:
            self._write(value)
        return value

    def update(self, changes: dict[str, Any]) -> Preferences:
        """Modifie seulement les champs fournis (les autres préférences sont gardées).

        Lecture, fusion et écriture sous le même verrou : deux modifications simultanées
        (mode en ligne et modèle, par exemple) ne s'écrasent pas.
        """
        with self._lock:
            merged = Preferences.model_validate({**self._value.model_dump(), **changes})
            self._write(merged)
        return merged

    def _write(self, value: Preferences) -> None:
        """Écriture atomique (fichier temporaire puis remplacement), à appeler sous le verrou."""
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(f".{self.path.name}.tmp")
        tmp.write_text(value.model_dump_json(indent=2), encoding="utf-8")
        os.replace(tmp, self.path)
        self._value = value
