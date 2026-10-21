/**
 * « Expliquer cette valeur » : décomposition d'un écart par les autres dimensions du jeu.
 *
 * - Axe de dates : écart avec la période précédente du visuel, réparti par valeur de chaque dimension
 *   (contributions additives : somme ou nombre de lignes).
 * - Autre axe : la répartition de l'élément comparée à celle de l'ensemble (sur- et sous-représentations).
 *
 * Tout est calculé par le moteur de requêtes ; ces constats (écrits comme à l'écran) sont ensuite
 * rédigés par l'IA, qui ne peut citer que leurs chiffres.
 */

import type { ColumnProfile, DatasetProfile, Scalar } from "../types/dataset";
import type { DateBin, Filter, QueryRequest } from "../types/query";
import type { FieldBinding, Visual } from "../types/report";
import { first, numberFormat } from "../visuals/common";
import { bindingKey, bindingLabel, measure } from "../visuals/fields";
import { formatDimension } from "../visuals/format";
import type { Selection } from "../visuals/types";
import type { QueryResult } from "../visuals/useQueryResult";
import { amount, percent } from "./facts";

export const MAX_DIMENSIONS = 5;
export const MAX_DISTINCT = 50;
const ADDITIVE = new Set(["sum", "count"]);

export interface ExplainTarget {
  mode: "previous" | "share";
  axis: FieldBinding;
  measure: FieldBinding;
  current: Scalar;
  previous: Scalar | null;
  currentValue: number;
  previousValue: number | null;
}

/** Ce qu'on peut expliquer d'un élément sélectionné (null : visuel ou mesure qui ne s'y prêtent pas). */
export function explainTarget(visual: Visual, result: QueryResult | null, selection: Selection | null, profile: DatasetProfile | undefined): ExplainTarget | string {
  if (!result || !selection || selection.visualId !== visual.id) return "Cliquez droit sur un élément du visuel (barre, point, part).";
  const f = selection.filters[0];
  const axis = Object.values(visual.roles)
    .flat()
    .find((b) => !b.agg && f && b.field === f.field && (b.bin ?? null) === (f.bin ?? null));
  const m = first(visual, "values") ?? first(visual, "y");
  if (!f || !axis || !m) return "Ce visuel n'a pas d'axe et de valeur à décomposer.";
  if (!m.agg || !ADDITIVE.has(m.agg) || m.show) return `« ${bindingLabel(m)} » n'est pas additif : seules une somme ou un nombre de lignes se décomposent.`;
  const value = f.values[0] ?? null;
  const axisKey = bindingKey(axis);
  const valueKey = bindingKey(m);
  const rows = result.rows.filter((r) => !r.__grouping);
  const index = rows.findIndex((r) => (r[axisKey] ?? null) === value);
  const row = rows[index];
  if (!row) return "Élément introuvable dans le visuel.";
  const currentValue = Number(row[valueKey] ?? 0);
  const isDate = !!axis.bin || profile?.columns.find((c) => c.name === axis.field)?.type === "date";
  // Période précédente : la ligne d'avant sur l'axe (le visuel trie les dates dans l'ordre).
  const sorted = isDate ? [...rows].sort((a, b) => String(a[axisKey] ?? "").localeCompare(String(b[axisKey] ?? ""))) : rows;
  const pos = sorted.indexOf(row);
  const before = isDate && pos > 0 ? sorted[pos - 1] : undefined;
  return {
    mode: before ? "previous" : "share",
    axis,
    measure: m,
    current: value,
    previous: before ? (before[axisKey] ?? null) : null,
    currentValue,
    previousValue: before ? Number(before[valueKey] ?? 0) : null,
  };
}

/** Dimensions candidates : texte ou booléen, 2 à 50 valeurs, hors axe ; les moins détaillées d'abord. */
export function candidateDimensions(profile: DatasetProfile | undefined, axisField: string): ColumnProfile[] {
  // Colonnes liées par l'axe lui-même (ventes.region → regions.*) : elles en dépendent, rien à expliquer.
  const sameAsAxis = new Set((profile?.model?.relations ?? []).filter((r) => r.from_column === axisField).map((r) => r.name));
  return (profile?.columns ?? [])
    .filter((c) => !(c.related && sameAsAxis.has(c.related)))
    .filter((c) => (c.type === "string" || c.type === "boolean") && c.name !== axisField && c.distinct >= 2 && c.distinct <= MAX_DISTINCT)
    .sort((a, b) => a.distinct - b.distinct)
    .slice(0, MAX_DIMENSIONS);
}

const axisFilter = (axis: FieldBinding, value: Scalar): Filter => ({ field: axis.field, op: "in", values: [value], bin: (axis.bin as DateBin | undefined) ?? null });

/** Requêtes d'une dimension : élément courant, et période précédente (ou ensemble, en mode « part »). */
export function dimensionRequests(datasetId: string, target: ExplainTarget, dimension: string, filters: Filter[]): { current: QueryRequest; base: QueryRequest } {
  const others = filters.filter((f) => !(f.field === target.axis.field && (f.bin ?? null) === (target.axis.bin ?? null)));
  const req = (extra: Filter[]): QueryRequest => ({ dataset_id: datasetId, dimensions: [{ field: dimension }], measures: [measure({ ...target.measure, show: null })], filters: [...others, ...extra], limit: 200 });
  return {
    current: req([axisFilter(target.axis, target.current)]),
    base: req(target.mode === "previous" ? [axisFilter(target.axis, target.previous)] : []),
  };
}

export interface Contribution {
  key: string;
  current: number;
  base: number;
  /** Mode « précédent » : écart ; mode « part » : écart de part, en points. */
  delta: number;
}

export interface DimensionBreakdown {
  dimension: string;
  /** Part de l'écart (ou de l'écart de répartition) expliquée par le premier contributeur. */
  score: number;
  items: Contribution[];
  /** Totaux de l'élément et de la base (période précédente ou ensemble). */
  totals: { current: number; base: number };
}

const toMap = (res: QueryResult, dim: string, key: string) => {
  const out = new Map<string, number>();
  for (const r of res.rows) out.set(r[dim] === null || r[dim] === undefined ? "(Vide)" : String(r[dim]), Number(r[key] ?? 0));
  return out;
};

/** Contributions d'une dimension, triées par importance (3 hausses et 3 baisses au plus). */
export function breakdown(target: ExplainTarget, dimension: string, current: QueryResult, base: QueryResult): DimensionBreakdown {
  const key = bindingKey({ ...target.measure, show: null });
  const cur = toMap(current, dimension, key);
  const prev = toMap(base, dimension, key);
  const curTotal = [...cur.values()].reduce((a, b) => a + b, 0);
  const prevTotal = [...prev.values()].reduce((a, b) => a + b, 0);
  const items: Contribution[] = [...new Set([...cur.keys(), ...prev.keys()])].map((k) => {
    const c = cur.get(k) ?? 0;
    const b = prev.get(k) ?? 0;
    const delta = target.mode === "previous" ? c - b : (curTotal ? c / curTotal : 0) * 100 - (prevTotal ? b / prevTotal : 0) * 100;
    return { key: k, current: c, base: b, delta };
  });
  const sum = items.reduce((a, i) => a + Math.abs(i.delta), 0);
  const ups = items.filter((i) => i.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 3);
  const downs = items.filter((i) => i.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 3);
  const ranked = [...ups, ...downs].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return { dimension, score: sum ? Math.abs(ranked[0]?.delta ?? 0) / sum : 0, items: ranked, totals: { current: curTotal, base: prevTotal } };
}

/** Les dimensions qui expliquent le mieux : celles où un contributeur pèse le plus. */
export function bestDimensions(list: DimensionBreakdown[], count = 2): DimensionBreakdown[] {
  return [...list].filter((d) => d.items.length).sort((a, b) => b.score - a.score).slice(0, count);
}

const signed = (s: string, v: number) => (v > 0 ? `+${s}` : s);
const points = (v: number) => `${v > 0 ? "+" : ""}${(Math.round(v * 10) / 10).toLocaleString("fr-FR")} points`;

/** Constats écrits comme à l'écran (lus et vérifiés par le backend). */
export function explainFacts(visual: Visual, target: ExplainTarget, dims: DimensionBreakdown[], axisType: ColumnProfile["type"] | undefined): string[] {
  const fmt = numberFormat(visual, target.measure);
  const label = (v: Scalar) => formatDimension(v, axisType, target.axis.bin ?? null);
  const measureName = bindingLabel(target.measure);
  const out: string[] = [];
  if (target.mode === "previous" && target.previousValue !== null) {
    const delta = target.currentValue - target.previousValue;
    out.push(`${measureName} : ${label(target.current)} — ${amount(target.currentValue, fmt)} ; ${label(target.previous)} — ${amount(target.previousValue, fmt)}`);
    const rel = target.previousValue ? ` (${percent(delta / Math.abs(target.previousValue), true)})` : "";
    out.push(`Écart de ${label(target.previous)} à ${label(target.current)} : ${signed(amount(delta, fmt), delta)}${rel}`);
    for (const d of dims) {
      for (const i of d.items.slice(0, 4)) {
        const share = delta ? ` (${percent(i.delta / Math.abs(delta))} de l'écart)` : "";
        out.push(`${d.dimension} = ${i.key} : ${signed(amount(i.delta, fmt), i.delta)}${share}, de ${amount(i.base, fmt)} à ${amount(i.current, fmt)}`);
      }
    }
  } else {
    out.push(`${measureName} de ${label(target.current)} : ${amount(target.currentValue, fmt)}`);
    for (const d of dims) {
      for (const i of d.items.slice(0, 4)) {
        const inElem = d.totals.current ? i.current / d.totals.current : 0;
        const inAll = d.totals.base ? i.base / d.totals.base : 0;
        out.push(`${d.dimension} = ${i.key} : ${percent(inElem)} de ${label(target.current)} contre ${percent(inAll)} de l'ensemble (${points(i.delta)})`);
      }
    }
  }
  return out.slice(0, 15).map((f) => f.slice(0, 300));
}
