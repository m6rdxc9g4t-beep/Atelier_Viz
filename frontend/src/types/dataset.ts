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
}

export interface DatasetRows {
  columns: string[];
  rows: Row[];
  total: number;
  offset: number;
  limit: number;
}
