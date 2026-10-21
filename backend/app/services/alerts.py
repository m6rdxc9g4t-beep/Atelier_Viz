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
import threading
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

from app.core.files import replace_file
from app.schemas.alert import (
    COMPARISON_SYMBOL,
    MAX_GROUPS,
    Alert,
    AlertEvent,
    AlertGroupEvent,
    AlertGroupState,
    AlertInput,
    AlertNotification,
    AlertTrigger,
    Comparison,
)
from app.schemas.query import Dimension, QueryRequest
from app.services.actions import ActionError, WebhookRequest, call_webhook
from app.services.data.store import DatasetStore
from app.services.engine.database import LocalDatabase
from app.services.engine.query import QueryError, run_query
from app.services.system_notify import Notifier

MAX_HISTORY = 50
MAX_NOTIFICATIONS = 100
MAX_ALERTS = 200
MAX_EVENT_GROUPS = 50
MAX_GROUP_NOTIFICATIONS = 10
EMPTY_KEY = "(vide)"


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


RULE_FIELDS = ("dataset_id", "measure", "filters", "comparison", "threshold", "basis", "split_by", "enabled")
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
        notifier: Notifier | None = None,
    ) -> None:
        self.path = path
        self.store = store
        self.db = db
        self.is_online = is_online
        self.clock = clock
        self.http_factory = http_factory
        self.notifier = notifier
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
        replace_file(tmp, self.path)

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
        """Vérifie la mesure, les filtres et la dimension contre le jeu (en l'évaluant une fois)."""
        self.measure_groups(data)

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
            rule = ("dataset_id", "measure", "filters", "comparison", "threshold", "basis", "split_by")
            changed_rule = any(getattr(current, k) != getattr(data, k) for k in rule)
            update: dict[str, Any] = data.model_dump()
            if changed_rule or (data.enabled and not current.enabled):
                # Nouvelle règle : l'état d'anti-rebond repart de zéro (et la référence d'une variation).
                update.update(met=None, groups={}, last_raw=None)
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

    def _query(self, rule: AlertInput, dimension: str | None) -> list[tuple[Any, ...]]:
        dataset = self.store.get(rule.dataset_id)
        if dataset is None:
            raise AlertError(f"Jeu de données « {rule.dataset_id} » introuvable.", 404)
        try:
            req = QueryRequest(
                dataset_id=rule.dataset_id,
                dimensions=[Dimension(field=dimension)] if dimension else [],
                measures=[rule.measure],
                filters=rule.filters,
                limit=MAX_GROUPS if dimension else 1,
            )
            return run_query(self.db, dataset.source, dataset.profile(), req).rows
        except QueryError as exc:
            raise AlertError(f"Mesure invalide : {exc}") from exc

    def measure(self, rule: AlertInput) -> float | None:
        """Valeur de la mesure sur le jeu filtré (moteur de requêtes ; aucune chaîne SQL du client)."""
        rows = self._query(rule, None)
        return _number(rows[0][0] if rows and rows[0] else None)

    def measure_groups(self, rule: AlertInput) -> dict[str, float | None]:
        """Mesure par valeur de la dimension (`split_by`), ou {"": total} sans dimension."""
        if not rule.split_by:
            return {"": self.measure(rule)}
        return {(EMPTY_KEY if key is None else str(key)): _number(v) for key, v in self._query(rule, rule.split_by)}

    def _unit(self, alert: AlertInput) -> str:
        return " %" if alert.basis == "change_pct" else ""

    def message(self, alert: Alert, value: float, group: str | None = None) -> str:
        label = {"value": "", "change_pct": " (variation)", "change_abs": " (écart)"}[alert.basis]
        unit = self._unit(alert)
        sign = "+" if alert.basis != "value" and value > 0 else ""
        where = f" · {group}" if group else ""
        return (
            f"{alert.name}{where}{label} : {sign}{format_number(value)}{unit} {COMPARISON_SYMBOL[alert.comparison]} "
            f"{format_number(alert.threshold)}{unit}"
        )

    async def evaluate(self, alert_id: str, trigger: AlertTrigger) -> Alert:
        """Évalue une alerte, déclenche ses actions au franchissement du seuil, et l'inscrit à l'historique.

        Avec une dimension, chaque valeur a son propre anti-rebond. Sur variation, la valeur comparée est
        l'écart (ou le %) avec la mesure de l'évaluation précédente ; la première mesure sert de référence.
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
                raws = await asyncio.to_thread(self.measure_groups, alert)
            except AlertError as exc:
                raws, event.error = {}, exc.message
            results = self._compare(alert, raws)
            if alert.split_by:
                event.groups_count = len(results)
                shown = [r for r in results if r.met or r.fired]
                event.groups = sorted(shown, key=lambda r: (not r.fired, r.key))[:MAX_EVENT_GROUPS]
                event.met = any(r.met for r in results)
                event.fired = any(r.fired for r in results)
                if not results and event.error is None:
                    event.error = "Aucune valeur (jeu vide après filtres) : état inchangé."
                elif alert.basis != "value" and results and all(r.value is None for r in results):
                    event.note = "Première mesure : elle sert de référence à la prochaine variation."
            else:
                total = results[0] if results else AlertGroupEvent(key="")
                event.value, event.met, event.fired = total.value, total.met, total.fired
                event.raw = total.raw if alert.basis != "value" else None
                if total.value is None and event.error is None:
                    if alert.basis != "value" and total.raw is not None:
                        event.note = "Première mesure : elle sert de référence à la prochaine variation."
                    else:
                        event.error = "Aucune valeur (jeu vide après filtres) : état inchangé."
            current, fired = await asyncio.to_thread(self._record, alert.id, fingerprint, event, results)
        if fired and current.system and self.notifier is not None:
            await asyncio.to_thread(self._system_notify, current, fired)
        if not (fired and current.webhook is not None):
            return current
        # Hors verrou : un webhook lent (15 s) ne bloque ni cette alerte ni les autres.
        await self._call_webhook(current, fired, now, event)
        return await asyncio.to_thread(self._complete, current.id, event)

    def _compare(self, alert: Alert, raws: dict[str, float | None]) -> list[AlertGroupEvent]:
        """Valeur comparée, condition et franchissement pour chaque valeur de la dimension."""
        out = []
        for key, raw in raws.items():
            state = alert.groups.get(key) if alert.split_by else AlertGroupState(met=alert.met, raw=alert.last_raw)
            previous_raw, previous_met = (state.raw, state.met) if state else (None, None)
            value = raw if alert.basis == "value" else _change(alert.basis, raw, previous_raw)
            met = compare(value, alert.comparison, alert.threshold) if value is not None else None
            fired = bool(met) and previous_met is not True and alert.enabled
            out.append(AlertGroupEvent(key=key, value=value, raw=raw, met=bool(met), fired=fired))
        return out

    def _system_notify(self, alert: Alert, fired: list[AlertGroupEvent]) -> None:
        assert self.notifier is not None
        for g in fired[:MAX_GROUP_NOTIFICATIONS]:
            if g.value is not None:
                self.notifier("Atelier Viz · alerte", self.message(alert, g.value, g.key or None))
        if len(fired) > MAX_GROUP_NOTIFICATIONS:
            rest = len(fired) - MAX_GROUP_NOTIFICATIONS
            self.notifier("Atelier Viz · alerte", f"{alert.name} : {rest} autres valeurs.")

    async def _call_webhook(self, alert: Alert, fired: list[AlertGroupEvent], now: datetime, event: AlertEvent) -> None:
        assert alert.webhook is not None
        first = fired[0]
        payload: dict[str, Any] = {
            "alerte": alert.name,
            "jeu_de_donnees": alert.dataset_id,
            "base": alert.basis,
            "valeur": first.value,
            "comparaison": COMPARISON_SYMBOL[alert.comparison],
            "seuil": alert.threshold,
            "message": self.message(alert, first.value or 0.0, first.key or None),
            "declenche_le": now.isoformat(),
        }
        if alert.split_by:
            payload["dimension"] = alert.split_by
            payload["valeurs"] = [{"valeur_dimension": g.key, "valeur": g.value, "mesure": g.raw} for g in fired]
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

    def _record(
        self, alert_id: str, fingerprint: str, event: AlertEvent, results: list[AlertGroupEvent]
    ) -> tuple[Alert, list[AlertGroupEvent]]:
        """Enregistre l'évaluation ; (alerte, valeurs déclenchées). Ignorée si la règle a changé depuis la lecture."""
        with self._lock:
            alerts, notes = self._read()
            current = next((a for a in alerts if a.id == alert_id), None)
            if current is None:  # supprimée pendant l'évaluation
                raise AlertError(f"Alerte « {alert_id} » introuvable.", 404)
            if rule_fingerprint(current) != fingerprint:
                # `update` a remis l'anti-rebond à zéro pour une autre règle : ne pas l'écraser.
                event.met, event.fired, event.error, event.groups = False, False, STALE, []
                current.history = [event, *current.history][:MAX_HISTORY]
                self._write(alerts, notes)
                return current, []
            fired = [r for r in results if r.fired and r.value is not None]
            if current.split_by:
                groups = dict(current.groups)
                for r in results:
                    previous = groups.get(r.key, AlertGroupState())
                    groups[r.key] = AlertGroupState(
                        met=r.met if r.value is not None else previous.met,
                        value=r.value if r.value is not None else previous.value,
                        raw=r.raw if r.raw is not None else previous.raw,
                    )
                current.groups = groups
                if results:
                    current.met = any(g.met for g in groups.values())
            elif results:
                total = results[0]
                if total.value is not None:
                    current.met = total.met
                    current.last_value = total.value
                if total.raw is not None:
                    current.last_raw = total.raw
            current.last_evaluated_at = event.at
            if fired:
                current.last_fired_at = event.at
                if current.notify:
                    new_notes = [
                        AlertNotification(
                            id=uuid.uuid4().hex[:12],
                            alert_id=current.id,
                            alert_name=current.name,
                            dataset_id=current.dataset_id,
                            message=self.message(current, r.value or 0.0, r.key or None),
                            value=r.value or 0.0,
                            group=r.key or None,
                            threshold=current.threshold,
                            comparison=current.comparison,
                            at=event.at,
                        )
                        for r in fired[:MAX_GROUP_NOTIFICATIONS]
                    ]
                    notes = [*new_notes, *notes][:MAX_NOTIFICATIONS]
            current.history = [event, *current.history][:MAX_HISTORY]
            self._write(alerts, notes)
            return current, fired

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


def _number(value: Any) -> float | None:
    if isinstance(value, bool):
        return float(value)
    if isinstance(value, (int, float)) and math.isfinite(value):
        return float(value)
    return None


def _change(basis: str, raw: float | None, previous: float | None) -> float | None:
    """Variation depuis la mesure précédente : écart, ou % (vide si la référence est nulle ou absente)."""
    if raw is None or previous is None:
        return None
    if basis == "change_abs":
        return raw - previous
    if previous == 0:
        return None
    return (raw - previous) / abs(previous) * 100
