"""Idempotence des écritures du nœud Atelier (docs/SUITE.md §7.4), en-tête `Idempotency-Key`.

- Même clé + même corps → la réponse enregistrée est rejouée telle quelle (`Idempotency-Replayed: true`),
  sans refaire l'écriture ; même clé + autre corps → 409 `IDEMPOTENCY_KEY_REUSED`.
- Empreinte : sha256 du corps validé, sérialisé en JSON canonique (clés triées) : l'ordre des clés ou les
  espaces ne changent pas l'empreinte.
- Seules les réponses réussies sont enregistrées : une requête refusée (422, 409 de modèle) peut être corrigée
  et renvoyée avec la même clé.
- Stockage : `data/atelier_idempotency.json` (verrou + écriture atomique), une entrée par (action, clé),
  conservée `ttl` (30 jours) ; `max_entries` au plus (les plus anciennes partent d'abord).
- Concurrence : `lock(scope, key)` sérialise deux requêtes portant la même clé (la seconde attend puis rejoue).

Méthodes `lookup` / `save` synchrones (disque) : via `asyncio.to_thread`.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

MAX_KEY_LENGTH = 200


def fingerprint(body: Any) -> str:
    """Empreinte sha256 d'un corps JSON (forme canonique)."""
    text = json.dumps(body, sort_keys=True, ensure_ascii=False, separators=(",", ":"), default=str)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class StoredResponse:
    """Réponse enregistrée pour une clé."""

    fingerprint: str
    status_code: int
    body: Any


class IdempotencyStore:
    """Registre persistant des réponses par clé d'idempotence."""

    def __init__(
        self,
        path: Path,
        ttl: timedelta = timedelta(days=30),
        max_entries: int = 10_000,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.path = path
        self.ttl = ttl
        self.max_entries = max_entries
        self.clock = clock
        self._lock = threading.Lock()
        self._key_locks: dict[str, asyncio.Lock] = {}

    @staticmethod
    def _id(scope: str, key: str) -> str:
        return f"{scope}\n{key}"

    def lock(self, scope: str, key: str) -> asyncio.Lock:
        """Verrou asyncio propre à (action, clé)."""
        return self._key_locks.setdefault(self._id(scope, key), asyncio.Lock())

    def _read(self) -> dict[str, dict[str, Any]]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return {}
        entries = raw.get("entries") if isinstance(raw, dict) else None
        return entries if isinstance(entries, dict) else {}

    def _write(self, entries: dict[str, dict[str, Any]]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"version": 1, "entries": entries}, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, self.path)

    def _fresh(self, entries: dict[str, dict[str, Any]]) -> dict[str, dict[str, Any]]:
        limit = self.clock() - self.ttl
        kept = {}
        for k, v in entries.items():
            try:
                if datetime.fromisoformat(str(v.get("at"))) >= limit:
                    kept[k] = v
            except ValueError:
                continue
        if len(kept) > self.max_entries:
            ordered = sorted(kept.items(), key=lambda kv: str(kv[1].get("at")))
            kept = dict(ordered[-self.max_entries :])
        return kept

    def lookup(self, scope: str, key: str) -> StoredResponse | None:
        """Réponse enregistrée (encore valable) pour cette clé, ou None."""
        with self._lock:
            entry = self._fresh(self._read()).get(self._id(scope, key))
        if entry is None:
            return None
        return StoredResponse(str(entry["fingerprint"]), int(entry["status"]), entry["body"])

    def save(self, scope: str, key: str, fp: str, status_code: int, body: Any) -> None:
        """Enregistre la réponse d'une écriture réussie (purge des entrées expirées au passage)."""
        with self._lock:
            entries = self._fresh(self._read())
            entries[self._id(scope, key)] = {
                "fingerprint": fp,
                "status": status_code,
                "body": body,
                "at": self.clock().isoformat(),
            }
            self._write(entries)
