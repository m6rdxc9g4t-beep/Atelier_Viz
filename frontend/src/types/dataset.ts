/** Miroir de backend/app/schemas/dataset.py — garder synchronisé. */

export type ColumnType = "number" | "string" | "date" | "boolean";
export type SourceFormat = "csv" | "xlsx" | "json";
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

/** Colonnes et mesures calculées d'un jeu de données. */
export interface DatasetModel {
  columns: CalculatedColumn[];
  measures: CalculatedMeasure[];
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
  kind: "column" | "measure";
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
}

export interface DatasetProfile extends DatasetSummary {
  columns: ColumnProfile[];
  sample: Row[];
  model?: DatasetModel;
}

export interface DatasetRows {
  columns: string[];
  rows: Row[];
  total: number;
  offset: number;
  limit: number;
}
