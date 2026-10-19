/** Miroir de backend/app/schemas/query.py — garder synchronisé. */

import type { ColumnType, Scalar } from "./dataset";

export type Agg = "sum" | "avg" | "min" | "max" | "count" | "count_distinct" | "median";
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

export interface Measure {
  field?: string | null;
  agg: Agg;
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
