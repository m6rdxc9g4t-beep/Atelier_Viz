/** Miroir de backend/app/schemas/connection.py — garder synchronisé. */

import type { Row } from "./dataset";

export type ConnectorKind = "sqlserver" | "postgres" | "mysql" | "sqlite" | "file" | "sharepoint";
export const SERVER_KINDS: ConnectorKind[] = ["sqlserver", "postgres", "mysql"];
export const SQL_KINDS: ConnectorKind[] = ["sqlserver", "postgres", "mysql", "sqlite"];

export interface ConnectionFields {
  name: string;
  kind: ConnectorKind;
  host?: string | null;
  port?: number | null;
  database?: string | null;
  username?: string | null;
  encrypt?: boolean;
  path?: string | null;
  tenant?: string | null;
  client_id?: string | null;
}

/** Création / modification : `password` absent = inchangé, "" = effacé. */
export interface ConnectionInput extends ConnectionFields {
  password?: string | null;
}

export interface Connection extends ConnectionFields {
  id: string;
  created_at: string;
  has_password: boolean;
  signed_in: boolean;
  account: string | null;
}

export interface TableRef {
  schema?: string | null;
  name: string;
  kind?: "table" | "view" | "sheet" | "list";
}

export interface SourceSpec {
  table?: TableRef | null;
  query?: string | null;
  url?: string | null;
}

export interface PreviewRequest extends SourceSpec {
  limit?: number;
}

export interface ImportRequest extends SourceSpec {
  name?: string | null;
  max_rows?: number | null;
}

export interface PreviewResult {
  columns: string[];
  rows: Row[];
  truncated: boolean;
}

export interface TestResult {
  ok: boolean;
  message: string;
  server: string | null;
}

export interface TableList {
  tables: TableRef[];
  truncated: boolean;
}

export interface ConnectorInfo {
  kind: ConnectorKind;
  label: string;
  description: string;
  driver_installed: boolean;
  install_hint: string | null;
  default_port: number | null;
  needs_online: boolean;
  configured: boolean;
}

export interface DeviceCodeStart {
  user_code: string;
  verification_uri: string;
  message: string;
  expires_in: number;
  interval: number;
}

export interface AuthStatus {
  status: "pending" | "signed_in" | "expired" | "denied" | "error";
  account: string | null;
  message: string | null;
}

/** Provenance d'un jeu importé depuis une connexion : permet de l'actualiser. */
export interface DatasetOrigin {
  connection_id: string;
  connection_name: string;
  kind: ConnectorKind;
  table: TableRef | null;
  query: string | null;
  url: string | null;
  max_rows: number | null;
  truncated: boolean;
  refreshed_at: string;
}

/** Libellé lisible d'une table (« schéma.nom », sauf schéma par défaut). */
export function tableLabel(t: TableRef): string {
  return t.schema && !["dbo", "public"].includes(t.schema) ? `${t.schema}.${t.name}` : t.name;
}
