/** Miroir de backend/app/schemas/alert.py — garder synchronisé. */

import type { Filter, Measure } from "./query";

export type Comparison = "gt" | "gte" | "lt" | "lte" | "eq" | "neq";
export type AlertTrigger = "refresh" | "manual" | "created";
/** Valeur comparée au seuil : la mesure, ou sa variation (%, écart) depuis l'évaluation précédente. */
export type AlertBasis = "value" | "change_pct" | "change_abs";

export interface AlertWebhook {
  url: string;
  method: "GET" | "POST";
}

/** Création ou modification d'une alerte. La mesure est compilée par le moteur (jamais de SQL). */
export interface AlertInput {
  name: string;
  dataset_id: string;
  measure: Measure;
  filters: Filter[];
  comparison: Comparison;
  threshold: number;
  basis?: AlertBasis;
  /** Dimension : évaluée pour chaque valeur (« pour chaque région »). */
  split_by?: string | null;
  enabled: boolean;
  /** Notification dans l'application. */
  notify: boolean;
  /** Notification système (macOS, Windows, Linux). */
  system?: boolean;
  webhook: AlertWebhook | null;
}

export interface AlertGroupState {
  met: boolean | null;
  value: number | null;
  raw: number | null;
}

export interface AlertGroupEvent {
  key: string;
  value: number | null;
  raw: number | null;
  met: boolean;
  fired: boolean;
}

export interface AlertEvent {
  /** Identifiant (absent des historiques antérieurs). */
  id?: string | null;
  at: string;
  trigger: AlertTrigger;
  value: number | null;
  /** Mesure, quand la valeur comparée est une variation. */
  raw?: number | null;
  met: boolean;
  /** Franchissement du seuil : actions lancées. */
  fired: boolean;
  /** Alerte « pour chaque » : valeurs qui remplissent la condition. */
  groups?: AlertGroupEvent[];
  groups_count?: number | null;
  error: string | null;
  /** Information (première mesure d'une variation…). */
  note?: string | null;
  webhook_status: number | null;
  webhook_error: string | null;
}

export interface Alert extends AlertInput {
  id: string;
  created_at: string;
  /** Condition remplie à la dernière évaluation (anti-rebond) ; null = jamais évaluée. */
  met: boolean | null;
  last_value: number | null;
  last_raw?: number | null;
  /** État par valeur de la dimension. */
  groups?: Record<string, AlertGroupState>;
  last_evaluated_at: string | null;
  last_fired_at: string | null;
  /** Le plus récent en premier. */
  history: AlertEvent[];
}

export interface AlertNotification {
  id: string;
  alert_id: string;
  alert_name: string;
  dataset_id: string;
  message: string;
  value: number;
  group?: string | null;
  threshold: number;
  comparison: Comparison;
  at: string;
  read: boolean;
}
