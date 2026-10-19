/** Miroir de backend/app/schemas/refresh.py — garder synchronisé. */

import type { ConnectorKind } from "./connection";

export type ScheduleMode = "off" | "interval" | "daily";
export type RunStatus = "success" | "error" | "skipped";
export type RunTrigger = "schedule" | "manual";

/** Planification : désactivée, toutes les N minutes / heures, ou chaque jour à HH:MM (heure locale). */
export interface RefreshSchedule {
  mode: ScheduleMode;
  every: number;
  unit: "minutes" | "hours";
  /** HH:MM, heure locale de la machine (mode `daily`). */
  at: string;
}

export interface RefreshRun {
  started_at: string;
  duration_ms: number;
  status: RunStatus;
  trigger: RunTrigger;
  rows: number | null;
  message: string | null;
}

export interface ScheduleState {
  dataset_id: string;
  dataset_name: string;
  connection_name: string;
  kind: ConnectorKind;
  schedule: RefreshSchedule;
  next_run: string | null;
  running: boolean;
  /** Source sur Internet (SharePoint) : mode « En ligne » requis. */
  needs_online: boolean;
  refreshed_at: string | null;
  /** Le plus récent d'abord. */
  runs: RefreshRun[];
}
