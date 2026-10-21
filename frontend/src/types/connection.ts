/** Miroir de backend/app/schemas/connection.py — garder synchronisé. */

import type { Row } from "./dataset";

export type ConnectorKind = "sqlserver" | "postgres" | "mysql" | "sqlite" | "file" | "sharepoint" | "atelier_tab" | "atelier_projets";
export const SERVER_KINDS: ConnectorKind[] = ["sqlserver", "postgres", "mysql"];
export const SQL_KINDS: ConnectorKind[] = ["sqlserver", "postgres", "mysql", "sqlite"];
/** Applications de la Suite Atelier (docs/SUITE.md §4.2 et §4.3) : aucun secret. */
export const SUITE_KINDS: ConnectorKind[] = ["atelier_tab", "atelier_projets"];

export interface ConnectionFields {
  name: string;
  kind: ConnectorKind;
  host?: string | null;
  port?: number | null;
  database?: string | null;
  username?: string | null;
  encrypt?: boolean;
  /** SQLite / fichier : chemin du fichier ; Atelier Tab : dossier des instantanés (vide = défaut). */
  path?: string | null;
  tenant?: string | null;
  client_id?: string | null;
  /** Atelier Projets : adresse de l'API locale (vide = défaut). */
  base_url?: string | null;
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

/** Table, vue, feuille, liste ; table publiée par Atelier Tab (`snapshot`, `schema` = projet) ou jeu d'Atelier Projets (`dataset`). */
export interface TableRef {
  schema?: string | null;
  name: string;
  kind?: "table" | "view" | "sheet" | "list" | "snapshot" | "dataset";
  /** Identifiant stable dans la source (fichier d'Atelier Tab, nom du jeu d'Atelier Projets). */
  id?: string | null;
  description?: string | null;
  updated_at?: string | null;
  rows?: number | null;
}

export interface SourceSpec {
  table?: TableRef | null;
  query?: string | null;
  url?: string | null;
  /** Atelier Projets : limiter le jeu à un projet. */
  project_id?: string | null;
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

/** Projet d'Atelier Projets (filtre facultatif). */
export interface ProjectRef {
  id: string;
  name: string;
}

export interface TableList {
  tables: TableRef[];
  truncated: boolean;
  /** Atelier Projets : projets disponibles. */
  projects: ProjectRef[];
  /** Dossier ou adresse effectivement lus. */
  location: string | null;
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
  /** Atelier Tab : dossier par défaut ; Atelier Projets : adresse par défaut. */
  default_location: string | null;
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
  project_id: string | null;
  max_rows: number | null;
  truncated: boolean;
  refreshed_at: string;
}

/** Jeu alimenté par un workflow (docs/SUITE.md §7, action `datasets.upsert_table`) : pas de source à relire. */
export interface AtelierTableOrigin {
  kind: "atelier-table";
  /** Clé externe stable choisie par l'appelant (Atelier Nexus). */
  key: string;
  table_name: string | null;
  refreshed_at: string;
}

/** Provenance d'un jeu : connexion (actualisable) ou table reçue d'un workflow. */
export type AnyOrigin = DatasetOrigin | AtelierTableOrigin;

/** Vrai si le jeu vient d'une connexion (actualisable et planifiable). */
export function isConnectionOrigin(origin: AnyOrigin | null | undefined): origin is DatasetOrigin {
  return !!origin && origin.kind !== "atelier-table";
}

/** Libellé lisible d'une table (« schéma.nom », sauf schéma par défaut). */
export function tableLabel(t: TableRef): string {
  return t.schema && !["dbo", "public"].includes(t.schema) ? `${t.schema}.${t.name}` : t.name;
}
