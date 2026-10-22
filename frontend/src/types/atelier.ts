/**
 * Miroir de backend/app/schemas/atelier.py — garder synchronisé.
 * Nœud Atelier (docs/SUITE.md §7, contrat `atelier-node/1`) : manifeste, table d'échange, événements.
 */

export type AtelierType = "string" | "number" | "date" | "datetime" | "boolean";

/** Colonne d'une table d'échange : clé snake_case sans accent, libellé en français. */
export interface AtelierColumn {
  key: string;
  label: string;
  type: AtelierType;
}

/** Table `atelier-table/1` (`rows` utilise les `key` des colonnes). */
export interface AtelierTable {
  format: "atelier-table/1";
  name: string;
  label: string | null;
  columns: AtelierColumn[];
  rows: Record<string, unknown>[];
  /** Nombre complet de lignes, si connu. */
  total: number | null;
  truncated: boolean;
}

/** Corps de `POST /api/atelier/datasets` (action `datasets.upsert_table`). */
export interface UpsertTableInput {
  name: string;
  /** Clé externe stable : `^[a-z0-9][a-z0-9_.:-]{0,99}$`. */
  key: string;
  table: AtelierTable;
}

export interface UpsertTableResult {
  dataset_id: string;
  name: string;
  rows: number;
  action: "created" | "updated";
}

export interface ManifestAction {
  id: string;
  label: string;
  description: string;
  kind: "read" | "write" | "destructive";
  http: { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string } | null;
  mcp_tool: string | null;
  input_schema: Record<string, unknown>;
  output: { format: "atelier-table/1" | "json"; schema: Record<string, unknown> };
  idempotency: "header" | "field" | "natural" | "none";
}

export interface ManifestEvent {
  type: string;
  label: string;
  data_schema: Record<string, unknown>;
}

export interface AtelierManifest {
  contract: "atelier-node/1";
  app: "viz" | "projets" | "tab";
  name: string;
  version: string;
  transport: "http" | "mcp";
  actions: ManifestAction[];
  events: ManifestEvent[];
}

export type VizEventType =
  | "viz.dataset.created"
  | "viz.dataset.refreshed"
  | "viz.dataset.refresh_failed"
  | "viz.dataset.deleted"
  | "viz.alert.triggered"
  | "viz.report.saved";

export interface AtelierEvent {
  seq: number;
  type: string;
  /** ISO 8601 avec fuseau. */
  at: string;
  subject: { kind: string; id: string; label: string | null };
  data: Record<string, unknown>;
}

/** Réponse de `GET /api/atelier/events`. */
export interface AtelierEventsPage {
  events: AtelierEvent[];
  next: number;
  oldest: number;
  gap: boolean;
}

/** Erreur des routes `/api/atelier/*` (docs/SUITE.md §7.5). */
export interface AtelierErrorBody {
  detail: string;
  code: string;
}
