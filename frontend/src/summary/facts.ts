/**
 * Faits d'une page pour le résumé IA : quelques constats chiffrés par visuel (total, premiers,
 * évolution, cible…), calculés ici à partir des résultats déjà affichés.
 *
 * Seuls ces faits partent vers l'IA (jamais les lignes du jeu de données), et le backend vérifie
 * que chaque nombre de la synthèse en provient : on les écrit donc exactement comme à l'écran.
 */

import type { Scalar } from "../types/dataset";
import type { QueryColumn } from "../types/query";
import type { Page, Visual } from "../types/report";
import type { VisualFacts } from "../types/summary";
import { first, numberFormat, role } from "../visuals/common";
import { drillView } from "../visuals/drill";
import { kpiGap } from "../visuals/data/KpiVisual";
import { buildMatrix } from "../visuals/data/pivot";
import { bindingKey, bindingLabel } from "../visuals/fields";
import { type NumberFormat, formatDimension, formatNumber } from "../visuals/format";
import { VISUALS } from "../visuals/registry";
import { opt } from "../visuals/types";
import type { QueryResult, Row } from "../visuals/useQueryResult";
import { defaultTitle } from "../visuals/title";

export const MAX_FACTS = 12;

export interface FactsData {
  result: QueryResult | null;
  error: string | null;
  trend: QueryResult | null;
}

interface Entry {
  raw: Scalar;
  label: string;
  value: number;
}

const SKIPPED = new Set(["slicer", "button", "text"]);

/** Montant tel qu'affiché : format du visuel, notation compacte au-delà de 10 000. */
export function amount(v: number, fmt: NumberFormat): string {
  return formatNumber(v, { ...fmt, compact: fmt.compact || Math.abs(v) >= 10_000 });
}

/** Part ou variation en % : « 22 % », « 4,5 % », « +48 % ». */
export function percent(ratio: number, signed = false): string {
  const p = ratio * 100;
  const text = formatNumber(Math.abs(p) < 10 ? Math.round(p * 10) / 10 : Math.round(p), { decimals: Math.abs(p) < 10 ? 1 : 0 });
  return `${signed && p > 0 ? "+" : ""}${text}\u00a0%`;
}

const ordinal = (i: number) => (i === 0 ? "1er" : `${i + 1}e`);

function measureLabel(visual: Visual, col: QueryColumn): string {
  for (const bindings of Object.values(visual.roles)) {
    const b = bindings.find((x) => bindingKey(x) === col.key);
    if (b) return bindingLabel(b);
  }
  return col.key;
}

function dimensionLabel(visual: Visual, col: QueryColumn): string {
  for (const bindings of Object.values(visual.roles)) {
    const b = bindings.find((x) => bindingKey(x) === col.key);
    if (b) return b.label || b.field;
  }
  return col.field ?? col.key;
}

const isAdditive = (key: string) => key.startsWith("sum(") || key.startsWith("count(");
const binOf = (col: QueryColumn) => (col.key.includes("|") ? (col.key.split("|")[1] as Parameters<typeof formatDimension>[2]) : null);
const dimText = (row: Row, col: QueryColumn) => formatDimension(row[col.key] ?? null, col.type, binOf(col));

function compare(a: Scalar, b: Scalar): number {
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "fr", { numeric: true });
}

/** Regroupe les lignes par valeur de la dimension (somme si la mesure est additive, sinon 1re valeur). */
function groupBy(rows: Row[], dim: QueryColumn, measure: QueryColumn): Entry[] {
  const map = new Map<string, Entry>();
  for (const r of rows) {
    const raw = r[dim.key] ?? null;
    const k = String(raw);
    const v = Number(r[measure.key] ?? 0);
    if (!Number.isFinite(v)) continue;
    const e = map.get(k);
    if (!e) map.set(k, { raw, label: dimText(r, dim), value: v });
    else if (isAdditive(measure.key)) e.value += v;
  }
  return [...map.values()];
}

/** Constats d'une série temporelle : période, début, fin, évolution, extrêmes, total. */
function timeFacts(entries: Entry[], label: string, fmt: NumberFormat, additive: boolean): string[] {
  const sorted = [...entries].sort((a, b) => compare(a.raw, b.raw));
  const firstE = sorted[0];
  const lastE = sorted[sorted.length - 1];
  if (!firstE || !lastE) return [];
  const out = [`${label} — période : ${firstE.label} → ${lastE.label} (${sorted.length} périodes)`];
  out.push(`Début : ${firstE.label} — ${amount(firstE.value, fmt)} ; fin : ${lastE.label} — ${amount(lastE.value, fmt)}`);
  if (firstE.value !== 0 && sorted.length > 1) out.push(`Évolution du début à la fin : ${percent((lastE.value - firstE.value) / Math.abs(firstE.value), true)}`);
  const max = sorted.reduce((m, e) => (e.value > m.value ? e : m), firstE);
  const min = sorted.reduce((m, e) => (e.value < m.value ? e : m), firstE);
  out.push(`Maximum : ${max.label} — ${amount(max.value, fmt)} ; minimum : ${min.label} — ${amount(min.value, fmt)}`);
  if (additive) out.push(`Total sur la période : ${amount(sorted.reduce((t, e) => t + e.value, 0), fmt)}`);
  out.push(`Moyenne par période : ${amount(sorted.reduce((t, e) => t + e.value, 0) / sorted.length, fmt)}`);
  return out;
}

/** Constats d'un classement : nombre, total, trois premiers avec leur part, dernier. */
function rankFacts(entries: Entry[], label: string, dimName: string, fmt: NumberFormat, additive: boolean): string[] {
  const sorted = [...entries].sort((a, b) => b.value - a.value);
  if (!sorted.length) return [];
  const total = sorted.reduce((t, e) => t + e.value, 0);
  const shares = additive && total > 0 && sorted.every((e) => e.value >= 0);
  const share = (e: Entry) => (shares ? ` (${percent(e.value / total)} du total)` : "");
  const out = [`${label} par ${dimName} : ${sorted.length} valeur${sorted.length > 1 ? "s" : ""}`];
  if (additive) out.push(`Total : ${amount(total, fmt)}`);
  sorted.slice(0, 3).forEach((e, i) => out.push(`${ordinal(i)} : ${e.label} — ${amount(e.value, fmt)}${share(e)}`));
  const last = sorted[sorted.length - 1];
  if (last && sorted.length > 3) out.push(`Dernier : ${last.label} — ${amount(last.value, fmt)}${share(last)}`);
  if (!additive && sorted.length > 1) out.push(`Moyenne des ${dimName} : ${amount(total / sorted.length, fmt)}`);
  return out;
}

/** Répartition par la 2e dimension (légende) : trois premières valeurs et leur part. */
function seriesFact(rows: Row[], dim: QueryColumn, measure: QueryColumn, dimName: string, fmt: NumberFormat): string | null {
  if (!isAdditive(measure.key)) return null;
  const entries = groupBy(rows, dim, measure).sort((a, b) => b.value - a.value);
  const total = entries.reduce((t, e) => t + e.value, 0);
  if (entries.length < 2 || total <= 0) return null;
  return `Par ${dimName} : ${entries
    .slice(0, 3)
    .map((e) => `${e.label} — ${amount(e.value, fmt)} (${percent(e.value / total)})`)
    .join(", ")}`;
}

function genericFacts(visual: Visual, result: QueryResult, fmt: NumberFormat): string[] {
  const dims = result.columns.filter((c) => c.role === "dimension");
  const meas = result.columns.filter((c) => c.role === "measure");
  const m = meas[0];
  if (!m || !result.rows.length) return [];
  const label = measureLabel(visual, m);
  if (!dims.length) return meas.slice(0, 4).map((c) => `${measureLabel(visual, c)} : ${amount(Number(result.rows[0]?.[c.key] ?? 0), fmt)}`);

  const d0 = dims[0] as QueryColumn;
  const additive = isAdditive(m.key);
  const entries = groupBy(result.rows, d0, m);
  const out =
    d0.type === "date"
      ? timeFacts(entries, label, fmt, additive)
      : rankFacts(entries, label, dimensionLabel(visual, d0), fmt, additive);
  const d1 = dims[1];
  if (d1) {
    const s = seriesFact(result.rows, d1, m, dimensionLabel(visual, d1), fmt);
    if (s) out.push(s);
  }
  const m2 = meas[1];
  if (m2 && isAdditive(m2.key)) out.push(`Total ${measureLabel(visual, m2)} : ${amount(result.rows.reduce((t, r) => t + Number(r[m2.key] ?? 0), 0), fmt)}`);
  if (result.truncated) out.push("Résultat partiel (limite de lignes atteinte)");
  return out;
}

function kpiFacts(visual: Visual, data: FactsData, fmt: NumberFormat): string[] {
  const valueB = first(visual, "values");
  const targetB = first(visual, "target");
  const row = data.result?.rows[0];
  if (!valueB || !row) return [];
  const value = Number(row[bindingKey(valueB)] ?? 0);
  const out = [`${bindingLabel(valueB)} : ${amount(value, fmt)}`];
  const fixed = typeof visual.options.target === "number" ? visual.options.target : null;
  const target = targetB ? Number(row[bindingKey(targetB)] ?? 0) : fixed;
  const gap = kpiGap(value, target);
  if (target !== null && gap !== null) {
    const higherIsBetter = opt<boolean>(visual, VISUALS[visual.type], "higherIsBetter") !== false;
    const good = higherIsBetter ? gap >= 0 : gap <= 0;
    out.push(`Cible : ${amount(target, fmt)} ; écart : ${percent(gap / 100, true)} (${good ? "favorable" : "défavorable"})`);
  }
  if (visual.type === "gauge") {
    const max = typeof visual.options.max === "number" ? visual.options.max : null;
    if (max !== null) out.push(`Plage de la jauge : ${amount(Number(visual.options.min ?? 0), fmt)} à ${amount(max, fmt)}`);
  }
  const trend = data.trend;
  if (trend && trend.rows.length > 1) {
    const dim = trend.columns.find((c) => c.role === "dimension");
    const m = trend.columns.find((c) => c.role === "measure");
    if (dim && m) out.push(...timeFacts(groupBy(trend.rows, dim, m), "Tendance", fmt, isAdditive(m.key)).slice(1, 3));
  }
  return out;
}

function matrixFacts(visual: Visual, result: QueryResult, fmt: NumberFormat): string[] {
  const rows = role(visual, "rows");
  const values = role(visual, "values");
  const column = first(visual, "columns");
  const m = values[0];
  const r0 = rows[0];
  if (!m || !r0) return [];
  const model = buildMatrix(result.rows, rows, column);
  const key = bindingKey(m);
  const entries: Entry[] = model.root.children.map((n) => ({
    raw: n.value,
    label: formatDimension(n.value, undefined, r0.bin),
    value: Number(n.cells.get("__total")?.[key] ?? 0),
  }));
  const out = rankFacts(entries, bindingLabel(m), r0.label || r0.field, fmt, m.agg === "sum" || m.agg === "count");
  const total = model.root.cells.get("__total")?.[key];
  if (total != null && !(m.agg === "sum" || m.agg === "count")) out.push(`Ensemble : ${amount(Number(total), fmt)}`);
  return out;
}

function tableFacts(visual: Visual, result: QueryResult, fmt: NumberFormat): string[] {
  const dims = result.columns.filter((c) => c.role === "dimension");
  const meas = result.columns.filter((c) => c.role === "measure");
  const out = [`${result.rows.length}${result.truncated ? " (ou plus)" : ""} lignes`];
  for (const c of meas.slice(0, 3)) {
    if (isAdditive(c.key)) out.push(`Total ${measureLabel(visual, c)} : ${amount(result.rows.reduce((t, r) => t + Number(r[c.key] ?? 0), 0), fmt)}`);
  }
  const m = meas[0];
  if (m && dims.length) {
    const top = [...result.rows].sort((a, b) => Number(b[m.key] ?? 0) - Number(a[m.key] ?? 0)).slice(0, 3);
    top.forEach((r, i) => out.push(`${ordinal(i)} (${measureLabel(visual, m)}) : ${dims.map((d) => dimText(r, d)).join(" · ")} — ${amount(Number(r[m.key] ?? 0), fmt)}`));
  }
  return out;
}

function scatterFacts(visual: Visual, result: QueryResult, fmt: NumberFormat): string[] {
  const d = first(visual, "details");
  const y = first(visual, "y");
  const x = first(visual, "x");
  if (!d || !y || !x) return [];
  const rows = result.rows.filter((r) => r[bindingKey(y)] != null);
  const top = [...rows].sort((a, b) => Number(b[bindingKey(y)] ?? 0) - Number(a[bindingKey(y)] ?? 0))[0];
  const out = [`${rows.length} points (un par ${d.field}) ; X = ${bindingLabel(x)}, Y = ${bindingLabel(y)}`];
  if (top) out.push(`Plus haut ${bindingLabel(y)} : ${String(top[bindingKey(d)] ?? "(Vide)")} — ${amount(Number(top[bindingKey(y)] ?? 0), fmt)}`);
  return out;
}

/** Constats chiffrés d'un visuel (liste vide si le visuel n'apporte pas de chiffre). */
export function visualFacts(visual: Visual, data: FactsData): string[] {
  visual = drillView(visual); // faits du niveau d'exploration affiché
  if (SKIPPED.has(visual.type) || data.error || !data.result) return [];
  const fmt = numberFormat(visual);
  let facts: string[];
  switch (visual.type) {
    case "kpi":
    case "gauge":
      facts = kpiFacts(visual, data, fmt);
      break;
    case "matrix":
      facts = matrixFacts(visual, data.result, fmt);
      break;
    case "table":
      facts = tableFacts(visual, data.result, fmt);
      break;
    case "scatter":
      facts = scatterFacts(visual, data.result, fmt);
      break;
    case "pointmap":
      facts = [`${data.result.rows.length} points sur la carte`];
      break;
    default:
      facts = genericFacts(visual, data.result, fmt);
  }
  return facts.slice(0, MAX_FACTS).map((f) => f.slice(0, 300));
}

/** Faits de toute la page, pour la requête de résumé (30 visuels au plus). */
export function pageFacts(page: Page, dataOf: (visualId: string) => FactsData | undefined): VisualFacts[] {
  const out: VisualFacts[] = [];
  const seen = new Set<string>();
  for (const v of page.visuals) {
    const data = dataOf(v.id);
    if (!data) continue;
    const facts = visualFacts(v, data);
    // Deux visuels des mêmes données (carte et barres du CA par région) : faits envoyés une seule fois.
    const key = facts.join("\n");
    if (!facts.length || seen.has(key)) continue;
    seen.add(key);
    out.push({ id: v.id, title: (v.title || defaultTitle(v)).slice(0, 200), type: v.type, facts });
  }
  return out.slice(0, 30);
}
