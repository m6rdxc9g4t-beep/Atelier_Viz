"""Alertes sur seuil : évaluation d'une mesure, anti-rebond, notifications et webhooks.

- Définitions, état et historique dans `data/alerts.json` (écriture atomique).
- La mesure est évaluée par le moteur de requêtes (`run_query`) : champs validés contre le profil,
  mesures calculées compilées par `expressions.py`, valeurs en paramètres liés. Jamais de SQL brut.
- Anti-rebond : l'alerte se déclenche quand la condition **devient** vraie (franchissement), pas à
  chaque évaluation où elle reste vraie. Une valeur vide ou une erreur ne change pas l'état.
- Évaluée après chaque actualisation réussie du jeu (`RefreshScheduler.on_refreshed`) et à la demande.
- Actions : notification dans l'application et / ou webhook via `app/services/actions.py`
  (hors ligne : adresses locales seulement ; l'URL n'est jamais journalisée).
- Concurrence : un verrou **par alerte** sérialise ses évaluations (l'anti-rebond lit un état à jour) ;
  l'état est enregistré avant l'appel du webhook, qui se fait **hors verrou** puis complète l'événement.
  `_record` compare l'empreinte de la règle (`rule_fingerprint`) lue avant la mesure à celle de l'alerte
  enregistrée : si la règle a changé entre-temps (`update`), le résultat est ignoré (ni état, ni action).
"""

import asyncio
import hashlib
import json
import math
import os
import threading
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

from app.schemas.alert import (
    COMPARISON_SYMBOL,
    Alert,
    AlertEvent,
    AlertInput,
    AlertNotification,
    AlertTrigger,
    Comparison,
)
from app.schemas.query import QueryRequest
from app.services.actions import ActionError, WebhookRequest, call_webhook
from app.services.data.store import DatasetStore
from app.services.engine.database import LocalDatabase
from app.services.engine.query import QueryError, run_query

MAX_HISTORY = 50
MAX_NOTIFICATIONS = 100
MAX_ALERTS = 200


class AlertError(Exception):
    """Erreur présentable (message en français) avec son code HTTP."""

    def __init__(self, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code


def compare(value: float, comparison: Comparison, threshold: float) -> bool:
    """Condition de l'alerte (égalité à 1e-9 près, pour les nombres décimaux)."""
    if comparison == "gt":
        return value > threshold
    if comparison == "gte":
        return value >= threshold
    if comparison == "lt":
        return value < threshold
    if comparison == "lte":
        return value <= threshold
    equal = math.isclose(value, threshold, rel_tol=1e-9, abs_tol=1e-9)
    return equal if comparison == "eq" else not equal


def format_number(value: float) -> str:
    """Nombre à la française (espace fine des milliers, virgule décimale)."""
    text = f"{value:,.2f}".rstrip("0").rstrip(".")
    return text.replace(",", " ").replace(".", ",")


RULE_FIELDS = ("dataset_id", "measure", "filters", "comparison", "threshold", "enabled")
STALE = "Règle modifiée pendant l'évaluation : résultat ignoré."


def rule_fingerprint(alert: AlertInput) -> str:
    """Empreinte de ce qui détermine `met` (règle et activation) : un changement invalide une évaluation en cours."""
    data = alert.model_dump(mode="json", include=set(RULE_FIELDS))
    return hashlib.sha256(json.dumps(data, sort_keys=True).encode("utf-8")).hexdigest()


class AlertService:
    """Registre, évaluation et historique des alertes."""

    def __init__(
        self,
        path: Path,
        store: DatasetStore,
        db: LocalDatabase,
        is_online: Callable[[], bool],
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        http_factory: Callable[[], httpx.AsyncClient] | None = None,
    ) -> None:
        self.path = path
        self.store = store
        self.db = db
        self.is_online = is_online
        self.clock = clock
        self.http_factory = http_factory
        self._lock = threading.Lock()  # fichier alerts.json
        self._eval_locks: dict[str, asyncio.Lock] = {}  # une évaluation à la fois par alerte

    # --- Persistance ----------------------------------------------------------------------------

    def _read(self) -> tuple[list[Alert], list[AlertNotification]]:
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return [], []
        if not isinstance(raw, dict):
            return [], []
        alerts, notes = [], []
        for item in raw.get("alerts", []):
            try:
                alerts.append(Alert.model_validate(item))
            except ValueError:
                continue
        for item in raw.get("notifications", []):
            try:
                notes.append(AlertNotification.model_validate(item))
            except ValueError:
                continue
        return alerts, notes

    def _write(self, alerts: list[Alert], notes: list[AlertNotification]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        payload: dict[str, Any] = {
            "version": 1,
            "alerts": [a.model_dump(mode="json") for a in alerts],
            "notifications": [n.model_dump(mode="json") for n in notes[:MAX_NOTIFICATIONS]],
        }
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, self.path)

    # --- Registre (synchrone : via asyncio.to_thread) ---------------------------------------------

    def list_alerts(self, dataset_id: str | None = None) -> list[Alert]:
        alerts, _ = self._read()
        return [a for a in alerts if dataset_id is None or a.dataset_id == dataset_id]

    def get(self, alert_id: str) -> Alert:
        for a in self._read()[0]:
            if a.id == alert_id:
                return a
        raise AlertError(f"Alerte « {alert_id} » introuvable.", 404)

    def _check(self, data: AlertInput) -> None:
        """Vérifie la mesure et les filtres contre le jeu (en l'évaluant une fois)."""
        self.measure(data)

    def create(self, data: AlertInput) -> Alert:
        self._check(data)
        alert = Alert(id=uuid.uuid4().hex[:12], created_at=self.clock(), **data.model_dump())
        with self._lock:
            alerts, notes = self._read()
            if len(alerts) >= MAX_ALERTS:
                raise AlertError(f"{MAX_ALERTS} alertes au plus.")
            alerts.append(alert)
            self._write(alerts, notes)
        return alert

    def update(self, alert_id: str, data: AlertInput) -> Alert:
        self._check(data)
        with self._lock:
            alerts, notes = self._read()
            current = next((a for a in alerts if a.id == alert_id), None)
            if current is None:
                raise AlertError(f"Alerte « {alert_id} » introuvable.", 404)
            rule = ("dataset_id", "measure", "filters", "comparison", "threshold")
            changed_rule = any(getattr(current, k) != getattr(data, k) for k in rule)
            update: dict[str, Any] = data.model_dump()
            if changed_rule or (data.enabled and not current.enabled):
                update["met"] = None  # nouvelle règle : l'état d'anti-rebond repart de zéro
            updated = Alert.model_validate({**current.model_dump(), **update})
            self._write([updated if a.id == alert_id else a for a in alerts], notes)
        return updated

    def delete(self, alert_id: str) -> None:
        with self._lock:
            alerts, notes = self._read()
            if not any(a.id == alert_id for a in alerts):
                raise AlertError(f"Alerte « {alert_id} » introuvable.", 404)
            self._write([a for a in alerts if a.id != alert_id], notes)
        self._eval_locks.pop(alert_id, None)

    def forget_dataset(self, dataset_id: str) -> None:
        """Supprime les alertes d'un jeu supprimé."""
        with self._lock:
            alerts, notes = self._read()
            kept = [a for a in alerts if a.dataset_id != dataset_id]
            if len(kept) != len(alerts):
                self._write(kept, notes)

    def notifications(self) -> list[AlertNotification]:
        return self._read()[1]

    def mark_read(self, ids: list[str] | None = None) -> list[AlertNotification]:
        """Marque des notifications (toutes si `ids` est vide) comme lues."""
        with self._lock:
            alerts, notes = self._read()
            for n in notes:
                if not ids or n.id in ids:
                    n.read = True
            self._write(alerts, notes)
            return notes

    # --- Évaluation -------------------------------------------------------------------------------

    def measure(self, rule: AlertInput) -> float | None:
        """Valeur de la mesure sur le jeu filtré (moteur de requêtes ; aucune chaîne SQL du client)."""
        dataset = self.store.get(rule.dataset_id)
        if dataset is None:
            raise AlertError(f"Jeu de données « {rule.dataset_id} » introuvable.", 404)
        try:
            req = QueryRequest(dataset_id=rule.dataset_id, measures=[rule.measure], filters=rule.filters, limit=1)
            res = run_query(self.db, dataset.source, dataset.profile(), req)
        except QueryError as exc:
            raise AlertError(f"Mesure invalide : {exc}") from exc
        value = res.rows[0][0] if res.rows and res.rows[0] else None
        if isinstance(value, bool):
            return float(value)
        if isinstance(value, (int, float)) and math.isfinite(value):
            return float(value)
        return None

    def message(self, alert: Alert, value: float) -> str:
        return (
            f"{alert.name} : {format_number(value)} {COMPARISON_SYMBOL[alert.comparison]} "
            f"{format_number(alert.threshold)}"
        )

    async def evaluate(self, alert_id: str, trigger: AlertTrigger) -> Alert:
        """Évalue une alerte, déclenche ses actions au franchissement du seuil, et l'inscrit à l'historique.

        Verrou propre à l'alerte (les autres alertes s'évaluent en parallèle) ; le webhook est appelé
        après l'enregistrement de l'état, hors verrou, et son résultat complète l'événement.
        """
        lock = self._eval_locks.setdefault(alert_id, asyncio.Lock())
        async with lock:  # évaluations successives de cette alerte : l'anti-rebond lit un état à jour
            alert = await asyncio.to_thread(self.get, alert_id)
            fingerprint = rule_fingerprint(alert)
            now = self.clock()
            event = AlertEvent(id=uuid.uuid4().hex[:12], at=now, trigger=trigger)
            try:
                value = await asyncio.to_thread(self.measure, alert)
            except AlertError as exc:
                value, event.error = None, exc.message
            event.value = value
            met = compare(value, alert.comparison, alert.threshold) if value is not None else None
            event.met = bool(met)
            if value is None and event.error is None:
                event.error = "Aucune valeur (jeu vide après filtres) : état inchangé."
            fire = met is True and alert.met is not True and alert.enabled
            event.fired = fire and value is not None
            current, notified = await asyncio.to_thread(self._record, alert.id, fingerprint, event, met)
        if not (notified and value is not None and current.webhook is not None):
            return current
        # Hors verrou : un webhook lent (15 s) ne bloque ni cette alerte ni les autres.
        await self._call_webhook(current, value, now, event)
        return await asyncio.to_thread(self._complete, current.id, event)

    async def _call_webhook(self, alert: Alert, value: float, now: datetime, event: AlertEvent) -> None:
        assert alert.webhook is not None
        payload = {
            "alerte": alert.name,
            "jeu_de_donnees": alert.dataset_id,
            "valeur": value,
            "comparaison": COMPARISON_SYMBOL[alert.comparison],
            "seuil": alert.threshold,
            "message": self.message(alert, value),
            "declenche_le": now.isoformat(),
        }
        client = self.http_factory() if self.http_factory else None
        try:
            res = await call_webhook(
                WebhookRequest(url=alert.webhook.url, method=alert.webhook.method, payload=payload),
                online=self.is_online(),
                client=client,
            )
            event.webhook_status = res.status_code
            if not res.ok:
                event.webhook_error = f"Réponse HTTP {res.status_code}."
        except ActionError as exc:
            event.webhook_error = str(exc)
        finally:
            if client is not None:
                await client.aclose()

    def _record(self, alert_id: str, fingerprint: str, event: AlertEvent, met: bool | None) -> tuple[Alert, bool]:
        """Enregistre l'évaluation ; (alerte, déclenchée). Ignorée si la règle a changé depuis la lecture."""
        with self._lock:
            alerts, notes = self._read()
            current = next((a for a in alerts if a.id == alert_id), None)
            if current is None:  # supprimée pendant l'évaluation
                raise AlertError(f"Alerte « {alert_id} » introuvable.", 404)
            if rule_fingerprint(current) != fingerprint:
                # `update` a remis l'anti-rebond à zéro pour une autre règle : ne pas l'écraser.
                event.met, event.fired, event.error = False, False, STALE
                current.history = [event, *current.history][:MAX_HISTORY]
                self._write(alerts, notes)
                return current, False
            if met is not None:
                current.met = met
                current.last_value = event.value
            current.last_evaluated_at = event.at
            if event.fired:
                current.last_fired_at = event.at
                if current.notify and event.value is not None:
                    note = AlertNotification(
                        id=uuid.uuid4().hex[:12],
                        alert_id=current.id,
                        alert_name=current.name,
                        dataset_id=current.dataset_id,
                        message=self.message(current, event.value),
                        value=event.value,
                        threshold=current.threshold,
                        comparison=current.comparison,
                        at=event.at,
                    )
                    notes = [note, *notes][:MAX_NOTIFICATIONS]
            current.history = [event, *current.history][:MAX_HISTORY]
            self._write(alerts, notes)
            return current, event.fired

    def _complete(self, alert_id: str, event: AlertEvent) -> Alert:
        """Ajoute le résultat du webhook à l'événement déjà enregistré."""
        with self._lock:
            alerts, notes = self._read()
            current = next((a for a in alerts if a.id == alert_id), None)
            if current is None:
                raise AlertError(f"Alerte « {alert_id} » introuvable.", 404)
            for i, past in enumerate(current.history):
                if past.id == event.id:
                    current.history[i] = past.model_copy(
                        update={"webhook_status": event.webhook_status, "webhook_error": event.webhook_error}
                    )
                    break
            self._write(alerts, notes)
            return current

    async def evaluate_dataset(self, dataset_id: str, trigger: AlertTrigger = "refresh") -> list[Alert]:
        """Évalue les alertes actives d'un jeu (après son actualisation)."""
        alerts = await asyncio.to_thread(self.list_alerts, dataset_id)
        out = []
        for a in alerts:
            if a.enabled:
                out.append(await self.evaluate(a.id, trigger))
        return out
