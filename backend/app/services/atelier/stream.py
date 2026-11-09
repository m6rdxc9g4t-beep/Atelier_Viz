"""Flux poussé des événements du nœud (Server-Sent Events), en plus de `GET /api/atelier/events`.

Extension d'Atelier Viz au contrat `atelier-node/1` (docs/SUITE.md §7.3, qui reste la référence) : même
journal, mêmes événements, mêmes `seq`. Un consommateur s'abonne au lieu d'interroger :

- `id:` = `seq` (le navigateur ou le client renvoie `Last-Event-ID` à la reconnexion : rien n'est perdu) ;
- `event:` = type d'événement, `data:` = événement JSON (forme de §7.3) ;
- `event: gap` si des événements ont été perdus depuis `since` (le consommateur relit l'état) ;
- commentaire `: ping` toutes les 15 s (connexions gardées ouvertes) ;
- la connexion se ferme d'elle-même après `timeout` secondes (une heure au plus) : le client se reconnecte.
"""

import json
from collections.abc import AsyncIterator, Awaitable, Callable

from app.services.atelier.journal import EventJournal

POLL_SECONDS = 1.0
PING_SECONDS = 15.0
BATCH = 200


def frame(event_type: str, data: dict | list | str, seq: int | None = None) -> str:
    """Un message SSE (une ligne `data:` : le JSON ne contient jamais de retour à la ligne)."""
    payload = data if isinstance(data, str) else json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    head = f"id: {seq}\n" if seq is not None else ""
    return f"{head}event: {event_type}\ndata: {payload}\n\n"


async def event_stream(
    journal: EventJournal,
    since: int | None,
    types: set[str] | None,
    timeout: float,
    disconnected: Callable[[], Awaitable[bool]],
    sleep: Callable[[float], Awaitable[None]],
    clock: Callable[[], float],
) -> AsyncIterator[str]:
    """Événements après `since` (sans `since` : seulement les nouveaux), puis au fil de l'eau."""
    start = clock()
    cursor = since if since is not None else journal.page(None, 1, None).next
    yield "retry: 3000\n\n"
    last_ping = start
    first = True
    while True:
        page = journal.page(cursor, BATCH, types)
        if first and page.gap:
            yield frame("gap", {"since": cursor, "oldest": page.oldest})
            last = journal.page(None, 1, None).next
            if cursor is not None and cursor > last:
                # Journal remis à zéro (ou `since` venu d'ailleurs) : reprendre au dernier `seq` réel,
                # sinon les nouveaux événements seraient ignorés jusqu'à ce que `seq` dépasse `since`.
                cursor = last
                first = False
                continue
        first = False
        for event in page.events:
            yield frame(event.type, event.model_dump(mode="json"), event.seq)
        cursor = page.next
        if len(page.events) == BATCH:
            continue  # rattrapage : la page suivante tout de suite
        now = clock()
        if now - start >= timeout or await disconnected():
            return
        if now - last_ping >= PING_SECONDS:
            yield ": ping\n\n"
            last_ping = now
        await sleep(POLL_SECONDS)
