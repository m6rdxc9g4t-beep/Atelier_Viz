/** Miroir de backend/app/schemas/alert.py — garder synchronisé. */

import type { Filter, Measure } from "./query";

export type Comparison = "gt" | "gte" | "lt" | "lte" | "eq" | "neq";
export type AlertTrigger = "refresh" | "manual" | "created";

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
  enabled: boolean;
  /** Notification dans l'application. */
  notify: boolean;
  webhook: AlertWebhook | null;
}

export interface AlertEvent {
  /** Identifiant (absent des historiques antérieurs). */
  id?: string | null;
  at: string;
  trigger: AlertTrigger;
  value: number | null;
  met: boolean;
  /** Franchissement du seuil : actions lancées. */
  fired: boolean;
  error: string | null;
  webhook_status: number | null;
  webhook_error: string | null;
}

export interface Alert extends AlertInput {
  id: string;
  created_at: string;
  /** Condition remplie à la dernière évaluation (anti-rebond) ; null = jamais évaluée. */
  met: boolean | null;
  last_value: number | null;
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
  threshold: number;
  comparison: Comparison;
  at: string;
  read: boolean;
}
