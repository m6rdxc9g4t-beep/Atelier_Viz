"""Journal d'événements du nœud Atelier (docs/SUITE.md §7.3) : `GET /api/atelier/events`.

Stockage : un fichier JSONL dans le dossier de données (`data/atelier_events.jsonl`), une ligne par événement.

- Pourquoi un fichier plutôt qu'une table DuckDB : le journal doit rester écrivable pendant toute la vie de
  l'application, y compris quand DuckDB est fermée (fin du lifespan, après l'arrêt de l'ordonnanceur) ou
  verrouillée par une longue requête ; il ne doit pas grossir ni dépendre de la base des données de
  l'utilisateur (sauvegarde, suppression). Un fichier texte s'inspecte aussi à la main. Le volume est
  petit (≈ 1 000 à 10 000 lignes de quelques centaines d'octets).
- Écriture : sous un verrou (fils et boucle asyncio), une ligne complète ajoutée d'un seul `write` en mode
  ajout puis `fsync` ; la rétention réécrit le fichier **atomiquement** (fichier temporaire + `os.replace`).
  Une ligne tronquée par une coupure est ignorée à la lecture.
- `seq` : entier strictement croissant, jamais réutilisé. Le dernier `seq` est aussi gardé dans un petit
  fichier à part (`atelier_events.seq`, écriture atomique) : il survit au redémarrage même si le journal est
  vidé ou abîmé. Au démarrage, le plus grand des deux est retenu.
- Rétention : les `keep` derniers (1 000 par défaut) **et** tous ceux de moins de `max_age` (30 jours),
  dans la limite de `hard_cap` (10 000) événements.
- Une émission ne fait jamais échouer l'opération qui l'a déclenchée : une erreur disque est journalisée.

Méthodes synchrones (disque) : depuis une route, passer par `asyncio.to_thread`.
"""

from __future__ import annotations

import logging
import os
import threading
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ValidationError

from app.schemas.atelier import EVENT_TYPES, AtelierEvent, AtelierEventsPage, EventSubject

logger = logging.getLogger(__name__)

Clock = Callable[[], datetime]


class EventJournal:
    """Journal persistant des événements d'Atelier Viz."""

    def __init__(
        self,
        path: Path,
        clock: Clock = lambda: datetime.now(UTC),
        keep: int = 1000,
        max_age: timedelta = timedelta(days=30),
        hard_cap: int = 10_000,
    ) -> None:
        self.path = path
        self.seq_path = path.with_suffix(".seq")
        self.clock = clock
        self.keep = keep
        self.max_age = max_age
        self.hard_cap = max(hard_cap, keep)
        self._lock = threading.Lock()
        self._events: list[AtelierEvent] = []
        self._last_seq = 0
        self._load()

    # --- Persistance ----------------------------------------------------------------------------

    def _load(self) -> None:
        events: list[AtelierEvent] = []
        try:
            with self.path.open(encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        events.append(AtelierEvent.model_validate_json(line))
                    except ValidationError:
                        continue  # ligne tronquée (coupure pendant l'écriture) ou illisible : ignorée
        except FileNotFoundError:
            pass
        events.sort(key=lambda e: e.seq)
        self._events = events
        stored = 0
        try:
            stored = int(self.seq_path.read_text(encoding="utf-8").strip() or 0)
        except (FileNotFoundError, ValueError):
            stored = 0
        self._last_seq = max(stored, events[-1].seq if events else 0)

    def _write_seq(self) -> None:
        tmp = self.seq_path.with_suffix(".seq.tmp")
        tmp.write_text(str(self._last_seq), encoding="utf-8")
        os.replace(tmp, self.seq_path)

    def _append(self, event: AtelierEvent) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        line = (event.model_dump_json() + "\n").encode("utf-8")
        fd = os.open(self.path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        try:
            os.write(fd, line)  # une seule écriture : la ligne arrive entière (ou pas du tout)
            os.fsync(fd)
        finally:
            os.close(fd)

    def _rewrite(self) -> None:
        """Réécrit le journal (après rétention) de façon atomique."""
        tmp = self.path.with_suffix(".jsonl.tmp")
        with tmp.open("w", encoding="utf-8") as fh:
            for event in self._events:
                fh.write(event.model_dump_json() + "\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, self.path)

    def _retain(self) -> bool:
        """Applique la rétention ; vrai si des événements ont été retirés."""
        if len(self._events) <= self.keep:
            return False
        limit = self.clock() - self.max_age
        cut = len(self._events) - self.keep  # candidats au retrait : tout sauf les `keep` derniers
        kept_old = [e for e in self._events[:cut] if _parse(e.at) >= limit]
        events = kept_old + self._events[cut:]
        events = events[-self.hard_cap :]
        if len(events) == len(self._events):
            return False
        self._events = events
        return True

    # --- Écriture -------------------------------------------------------------------------------

    def emit(self, type_: str, subject_id: str, label: str | None, data: BaseModel | dict[str, Any]) -> int | None:
        """Ajoute un événement ; renvoie son `seq` (None si l'écriture a échoué, l'opération continue).

        `type_` doit être déclaré dans `EVENT_TYPES` (et donc au manifeste) ; `data` est validé par son schéma.
        """
        if type_ not in EVENT_TYPES:
            raise ValueError(f"Type d'événement non déclaré au manifeste : « {type_} ».")
        _, kind, model = EVENT_TYPES[type_]
        payload = data if isinstance(data, model) else model.model_validate(data)
        try:
            with self._lock:
                event = AtelierEvent(
                    seq=self._last_seq + 1,
                    type=type_,
                    at=self.clock().astimezone().isoformat(timespec="seconds"),
                    subject=EventSubject(kind=kind, id=subject_id, label=label),
                    data=payload.model_dump(mode="json", exclude_none=True),
                )
                self._append(event)
                self._last_seq = event.seq
                self._write_seq()
                self._events.append(event)
                # Compaction par paquets : le fichier n'est réécrit qu'une fois tous les ~10 % de dépassement.
                if len(self._events) > self.keep + max(10, self.keep // 10) and self._retain():
                    self._rewrite()
                return event.seq
        except OSError as exc:
            logger.warning("Journal Atelier : événement %s non enregistré (%s).", type_, exc)
            return None

    # --- Lecture --------------------------------------------------------------------------------

    @property
    def last_seq(self) -> int:
        return self._last_seq

    def page(self, since: int | None, limit: int, types: set[str] | None = None) -> AtelierEventsPage:
        """Événements après `since` (exclusif), ou les plus récents ; format de docs/SUITE.md §7.3."""
        with self._lock:
            events = list(self._events)
            last = self._last_seq
        oldest = events[0].seq if events else last + 1
        matching = [e for e in events if types is None or e.type in types]
        if since is None:
            chosen = matching[-limit:] if limit else []
        else:
            chosen = [e for e in matching if e.seq > since][:limit]
        # `gap` : des événements postérieurs à `since` ne sont plus conservés (ou le journal a été remis à zéro).
        gap = since is not None and (since < oldest - 1 or since > last)
        if chosen:
            next_seq = chosen[-1].seq
        elif since is not None:
            next_seq = since
        else:
            next_seq = last
        return AtelierEventsPage(events=chosen, next=next_seq, oldest=oldest, gap=gap)


def _parse(at: str) -> datetime:
    try:
        value = datetime.fromisoformat(at)
    except ValueError:
        return datetime.min.replace(tzinfo=UTC)
    return value if value.tzinfo else value.replace(tzinfo=UTC)
