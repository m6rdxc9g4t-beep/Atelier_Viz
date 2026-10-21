/** Miroir de backend/app/schemas/query.py — garder synchronisé. */

import type { ColumnType, Scalar } from "./dataset";

/** `calc` : mesure calculée du modèle (`field` = nom de la mesure). */
export type Agg = "sum" | "avg" | "min" | "max" | "count" | "count_distinct" | "median" | "calc";
export type DateBin = "year" | "quarter" | "month" | "week" | "day";
export type FilterOp =
  | "in"
  | "not_in"
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between"
  | "contains"
  | "is_null"
  | "not_null";

export interface Dimension {
  field: string;
  bin?: DateBin | null;
}

/** Calculs rapides (« Afficher la valeur comme ») ; pourcentages renvoyés en points (12,5 = 12,5 %). */
export type ShowKind = "ytd" | "running" | "prev_year" | "yoy_diff" | "yoy_pct" | "moving_avg" | "pct_total";

export interface ShowAs {
  kind: ShowKind;
  /** Champ date de référence (tous les calculs sauf `pct_total`). */
  date?: string | null;
  /** Périodes de la moyenne mobile (2 à 60). */
  window?: number;
}

export interface Measure {
  field?: string | null;
  agg: Agg;
  show?: ShowAs | null;
}

export interface Filter {
  field: string;
  op: FilterOp;
  values: Scalar[];
  bin?: DateBin | null;
}

export interface Sort {
  key: string;
  desc?: boolean;
}

export interface QueryRequest {
  dataset_id: string;
  dimensions?: Dimension[];
  measures?: Measure[];
  filters?: Filter[];
  sort?: Sort[];
  limit?: number;
  grouping_sets?: string[][] | null;
}

export interface QueryColumn {
  key: string;
  field: string | null;
  role: "dimension" | "measure" | "grouping";
  type: ColumnType;
}

export interface QueryResponse {
  columns: QueryColumn[];
  rows: Scalar[][];
  truncated: boolean;
}
