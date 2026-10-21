/** Liaisons de champs : clés de requête, libellés, valeurs par défaut. */

import type { CalculatedMeasure, ColumnProfile, ColumnType, DatasetProfile } from "../types/dataset";
import type { Agg, DateBin, Dimension, Measure, ShowAs, ShowKind } from "../types/query";
import type { FieldBinding } from "../types/report";

export const AGG_LABELS: Record<Agg, string> = {
  sum: "Somme",
  avg: "Moyenne",
  median: "Médiane",
  min: "Minimum",
  max: "Maximum",
  count: "Nombre",
  count_distinct: "Nombre distinct",
  calc: "Mesure calculée",
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

/** Calculs rapides proposés sur une valeur (menu « Afficher »). */
export const SHOW_LABELS: Record<ShowKind, string> = {
  ytd: "Cumul depuis le début de l'année",
  running: "Cumul depuis le début",
  prev_year: "Même période l'an dernier (N-1)",
  yoy_diff: "Écart vs N-1",
  yoy_pct: "Évolution vs N-1 (%)",
  moving_avg: "Moyenne mobile",
  pct_total: "Part du total (%)",
};

/** Libellés courts, préfixés au nom de la valeur (« Cumul annuel de Somme de ca »). */
const SHOW_SHORT: Record<ShowKind, string> = {
  ytd: "Cumul annuel",
  running: "Cumul",
  prev_year: "N-1",
  yoy_diff: "Écart vs N-1",
  yoy_pct: "Évolution vs N-1",
  moving_avg: "Moyenne mobile",
  pct_total: "Part du total",
};

/** Calculs exprimés en pourcentage (affichés avec « % »). */
export const PERCENT_SHOWS: ReadonlySet<ShowKind> = new Set(["yoy_pct", "pct_total"]);

export const isPercent = (b: FieldBinding | undefined): boolean => !!b?.show && PERCENT_SHOWS.has(b.show.kind);

/** Suffixe de clé d'un calcul rapide (identique à `ShowAs.suffix` côté Python). */
export function showSuffix(show: ShowAs | null | undefined): string {
  if (!show) return "";
  return `@${show.kind}${show.kind === "moving_avg" ? (show.window ?? 3) : ""}`;
}

export const isMeasure = (b: FieldBinding): boolean => b.agg != null;

export function dimension(b: FieldBinding): Dimension {
  return { field: b.field, bin: b.bin ?? null };
}

export function measure(b: FieldBinding): Measure {
  const m: Measure = { field: b.field, agg: b.agg ?? "sum" };
  if (b.show) m.show = { kind: b.show.kind, date: b.show.date ?? null, window: b.show.window ?? 3 };
  return m;
}

/** Clé de colonne renvoyée par le backend (identique à `Dimension.key` / `Measure.key` côté Python). */
export function bindingKey(b: FieldBinding): string {
  if (b.agg) return `${b.agg}(${b.field})${showSuffix(b.show)}`;
  return b.bin ? `${b.field}|${b.bin}` : b.field;
}

export function bindingLabel(b: FieldBinding): string {
  if (b.label) return b.label;
  const base = b.agg === "calc" ? b.field : b.agg ? `${AGG_LABELS[b.agg]} de ${b.field}` : null;
  if (base && b.show) {
    const extra = b.show.kind === "moving_avg" ? ` (${b.show.window ?? 3} périodes)` : "";
    return `${SHOW_SHORT[b.show.kind]}${extra} — ${base}`;
  }
  if (base) return base;
  if (b.bin) return `${b.field} (${BIN_LABELS[b.bin]})`;
  return b.field;
}

/** Liaison par défaut quand on dépose un champ dans un rôle. */
export function defaultBinding(column: ColumnProfile, asMeasure: boolean): FieldBinding {
  if (column.measure) return { field: column.name, agg: "calc" };
  if (asMeasure) {
    const agg: Agg = column.type === "number" ? "sum" : column.type === "boolean" ? "sum" : "count";
    return { field: column.name, agg };
  }
  return column.type === "date" ? { field: column.name, bin: "month" } : { field: column.name };
}

/** Mesure calculée présentée comme un champ (glisser-déposer, clic). */
export function measureField(m: CalculatedMeasure): ColumnProfile {
  return { name: m.name, type: "number", nulls: 0, distinct: 0, min: null, max: null, mean: null, top_values: [], measure: true, expression: m.expression };
}

/** Champ d'un jeu de données par son nom : colonne (de base ou calculée) ou mesure calculée. */
export function findField(profile: DatasetProfile | undefined, name: string, measure = false): ColumnProfile | undefined {
  if (!profile) return undefined;
  if (measure) {
    const m = profile.model?.measures.find((x) => x.name === name);
    return m ? measureField(m) : undefined;
  }
  return profile.columns.find((c) => c.name === name);
}

/** Champs date d'un jeu (référence des calculs dans le temps), celui de l'axe du visuel en premier. */
export function dateFields(visual: { roles: Record<string, FieldBinding[]> }, profile: DatasetProfile | undefined): string[] {
  const dates = (profile?.columns ?? []).filter((c) => c.type === "date").map((c) => c.name);
  const onAxis = Object.values(visual.roles)
    .flat()
    .filter((b) => !b.agg && dates.includes(b.field))
    .map((b) => b.field);
  return [...new Set([...onAxis, ...dates])];
}

/**
 * Applique un calcul rapide à une valeur (null = valeur brute). Les calculs dans le temps prennent le
 * champ date de l'axe du visuel, sinon le premier champ date du jeu ; sans champ date, seul
 * `pct_total` est possible (retourne null).
 */
export function withShow(
  b: FieldBinding,
  kind: ShowKind | null,
  visual: { roles: Record<string, FieldBinding[]> },
  profile: DatasetProfile | undefined,
): FieldBinding | null {
  if (!kind) {
    const { show: _removed, ...rest } = b;
    return rest;
  }
  if (kind === "pct_total") return { ...b, show: { kind } };
  const current = b.show?.date && dateFields(visual, profile).includes(b.show.date) ? b.show.date : null;
  const date = current ?? dateFields(visual, profile)[0];
  if (!date) return null;
  return { ...b, show: { kind, date, ...(kind === "moving_avg" ? { window: b.show?.window ?? 3 } : {}) } };
}
