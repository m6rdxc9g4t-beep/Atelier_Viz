/** Miroir de backend/app/schemas/dataset.py — garder synchronisé. */

import type { AnyOrigin } from "./connection";

export type ColumnType = "number" | "string" | "date" | "boolean";
/** Fichier importé, type de la connexion d'origine, ou table reçue d'un workflow (`atelier_table`). */
export type SourceFormat = "csv" | "xlsx" | "json" | "sqlserver" | "postgres" | "mysql" | "sqlite" | "sharepoint" | "atelier_tab" | "atelier_projets" | "atelier_table";
export type Scalar = number | string | boolean | null;
export type Row = Record<string, Scalar>;

export interface ValueCount {
  value: string;
  count: number;
}

export interface ColumnProfile {
  name: string;
  type: ColumnType;
  nulls: number;
  distinct: number;
  min: Scalar;
  max: Scalar;
  mean: number | null;
  top_values: ValueCount[];
  /** Colonne calculée (définie dans le modèle). */
  calculated?: boolean;
  expression?: string | null;
  /** Colonne reprise d'un jeu lié : nom de la relation (« regions »). */
  related?: string | null;
  /** Côté client uniquement : mesure calculée présentée comme un champ glissable. */
  measure?: boolean;
}

export interface CalculatedColumn {
  name: string;
  expression: string;
}

export interface CalculatedMeasure {
  name: string;
  expression: string;
  description?: string | null;
}

/**
 * Relation plusieurs-à-un vers un autre jeu : ses colonnes deviennent `<name>.<colonne>` dans ce jeu,
 * et ses segments / sélections filtrent ce jeu.
 */
export interface Relation {
  name: string;
  dataset_id: string;
  from_column: string;
  to_column: string;
  /** Colonnes reprises (toutes si absent). */
  columns?: string[] | null;
}

/** Diagnostic d'une relation avant enregistrement. */
export interface RelationCheck {
  ok: boolean;
  error?: string | null;
  rows: number;
  matched: number;
  duplicates: number;
  unmatched_sample: string[];
}

/** Relations, colonnes et mesures calculées d'un jeu de données. */
export interface DatasetModel {
  columns: CalculatedColumn[];
  measures: CalculatedMeasure[];
  relations?: Relation[];
}

export interface ExpressionCheck {
  kind: "column" | "measure";
  name: string;
  expression: string;
}

export interface ExpressionResult {
  ok: boolean;
  type?: ColumnType | null;
  error?: string | null;
  /** Index du caractère fautif. */
  position?: number | null;
  preview: Scalar[];
}

export interface ModelIssue {
  kind: "column" | "measure" | "relation" | "step";
  name: string;
  error: string;
  position?: number | null;
}

export interface DatasetSummary {
  id: string;
  name: string;
  format: SourceFormat;
  rows: number;
  columns_count: number;
  created_at: string;
  /** Connexion d'origine (jeu actualisable), ou table reçue d'un workflow. */
  origin?: AnyOrigin | null;
}

export interface DatasetProfile extends DatasetSummary {
  columns: ColumnProfile[];
  sample: Row[];
  model?: DatasetModel;
  /** Étapes de préparation (rejouées à chaque actualisation). */
  steps?: PrepStep[];
}

// --- Préparation des données (miroir des étapes de backend/app/schemas/dataset.py) ---------------

export type PrepOp = "eq" | "neq" | "in" | "not_in" | "gt" | "gte" | "lt" | "lte" | "contains" | "not_contains" | "is_null" | "not_null";
export type TextMode = "trim" | "upper" | "lower" | "capitalize";

interface StepBase {
  note?: string | null;
}
export interface RenameStep extends StepBase {
  kind: "rename";
  column: string;
  to: string;
}
export interface RemoveStep extends StepBase {
  kind: "remove";
  columns: string[];
}
export interface CastStep extends StepBase {
  kind: "cast";
  column: string;
  to: ColumnType;
}
export interface FilterStep extends StepBase {
  kind: "filter";
  column: string;
  op: PrepOp;
  values: Scalar[];
}
export interface ReplaceStep extends StepBase {
  kind: "replace";
  column: string;
  find: Scalar;
  replace: Scalar;
  whole: boolean;
}
export interface FillStep extends StepBase {
  kind: "fill";
  column: string;
  value: Scalar;
  down: boolean;
}
export interface TextStep extends StepBase {
  kind: "text";
  column: string;
  mode: TextMode;
}
export interface DedupeStep extends StepBase {
  kind: "dedupe";
  columns: string[] | null;
}
export interface UnpivotStep extends StepBase {
  kind: "unpivot";
  columns: string[];
  attribute: string;
  value: string;
}
export interface SplitStep extends StepBase {
  kind: "split";
  column: string;
  separator: string;
  into: string[];
}
export type PrepStep = RenameStep | RemoveStep | CastStep | FilterStep | ReplaceStep | FillStep | TextStep | DedupeStep | UnpivotStep | SplitStep;
export type PrepKind = PrepStep["kind"];

/** Résultat des étapes (aperçu) : colonnes, premières lignes, erreur localisée. */
export interface PrepPreview {
  ok: boolean;
  error?: string | null;
  /** Indice de l'étape fautive. */
  step?: number | null;
  rows: number;
  raw_rows: number;
  columns: ColumnProfile[];
  sample: Row[];
}

export interface DatasetRows {
  columns: string[];
  rows: Row[];
  total: number;
  offset: number;
  limit: number;
}

/** Fichier d'exemple livré avec le dépôt (`samples/`). */
export interface SampleFile {
  name: string;
  imported: boolean;
}

export interface SamplesImport {
  datasets: DatasetSummary[];
  /** Fichiers importés par cet appel (les autres l'étaient déjà). */
  imported: string[];
}
