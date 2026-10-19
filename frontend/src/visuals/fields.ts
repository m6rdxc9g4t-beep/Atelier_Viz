/** Liaisons de champs : clés de requête, libellés, valeurs par défaut. */

import type { ColumnProfile, ColumnType } from "../types/dataset";
import type { Agg, DateBin, Dimension, Measure } from "../types/query";
import type { FieldBinding } from "../types/report";

export const AGG_LABELS: Record<Agg, string> = {
  sum: "Somme",
  avg: "Moyenne",
  median: "Médiane",
  min: "Minimum",
  max: "Maximum",
  count: "Nombre",
  count_distinct: "Nombre distinct",
};

export const BIN_LABELS: Record<DateBin, string> = {
  year: "Année",
  quarter: "Trimestre",
  month: "Mois",
  week: "Semaine",
  day: "Jour",
};

/** Agrégations valides selon le type de colonne. */
export function aggsFor(type: ColumnType | undefined): Agg[] {
  if (type === "number") return ["sum", "avg", "median", "min", "max", "count", "count_distinct"];
  if (type === "boolean") return ["sum", "avg", "count"];
  if (type === "date") return ["min", "max", "count", "count_distinct"];
  return ["count", "count_distinct", "min", "max"];
}

export const isMeasure = (b: FieldBinding): boolean => b.agg != null;

export function dimension(b: FieldBinding): Dimension {
  return { field: b.field, bin: b.bin ?? null };
}

export function measure(b: FieldBinding): Measure {
  return { field: b.field, agg: b.agg ?? "sum" };
}

/** Clé de colonne renvoyée par le backend (identique à `Dimension.key` / `Measure.key` côté Python). */
export function bindingKey(b: FieldBinding): string {
  if (b.agg) return `${b.agg}(${b.field})`;
  return b.bin ? `${b.field}|${b.bin}` : b.field;
}

export function bindingLabel(b: FieldBinding): string {
  if (b.label) return b.label;
  if (b.agg) return `${AGG_LABELS[b.agg]} de ${b.field}`;
  if (b.bin) return `${b.field} (${BIN_LABELS[b.bin]})`;
  return b.field;
}

/** Liaison par défaut quand on dépose un champ dans un rôle. */
export function defaultBinding(column: ColumnProfile, asMeasure: boolean): FieldBinding {
  if (asMeasure) {
    const agg: Agg = column.type === "number" ? "sum" : column.type === "boolean" ? "sum" : "count";
    return { field: column.name, agg };
  }
  return column.type === "date" ? { field: column.name, bin: "month" } : { field: column.name };
}
