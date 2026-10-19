/** Miroir de backend/app/schemas/report.py — garder synchronisé. */

import type { Agg, DateBin, Filter } from "./query";

export type VisualType =
  | "bar"
  | "column"
  | "line"
  | "area"
  | "combo"
  | "pie"
  | "donut"
  | "scatter"
  | "treemap"
  | "funnel"
  | "radar"
  | "waterfall"
  | "gauge"
  | "heatmap"
  | "kpi"
  | "table"
  | "matrix"
  | "map"
  | "pointmap"
  | "slicer"
  | "button"
  | "text";

export interface FieldBinding {
  field: string;
  /** Agrégation (mesure). Absent = dimension. */
  agg?: Agg | null;
  bin?: DateBin | null;
  label?: string | null;
}

/** Position d'un visuel en pixels de page (anciens rapports : cases de grille, converties à l'ouverture). */
export interface Layout {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Taille de la page en pixels (16:9 = 1280 × 720). */
export interface PageSize {
  width: number;
  height: number;
}

export type VisualOptions = Record<string, unknown>;

export interface Visual {
  id: string;
  type: VisualType;
  title?: string | null;
  layout: Layout;
  dataset_id?: string | null;
  roles: Record<string, FieldBinding[]>;
  options: VisualOptions;
  filters: Filter[];
}

export interface Page {
  id: string;
  name: string;
  visuals: Visual[];
  filters: Filter[];
  /** Absent = ancienne grille (convertie par `migratePage`). */
  size?: PageSize | null;
}

export interface ReportBody {
  name: string;
  dataset_id?: string | null;
  pages: Page[];
  theme: Record<string, unknown>;
}

export interface Report extends ReportBody {
  id: string;
  version: 1;
  created_at: string;
  updated_at: string;
}

export interface ReportSummary {
  id: string;
  name: string;
  pages: number;
  visuals: number;
  updated_at: string;
}
