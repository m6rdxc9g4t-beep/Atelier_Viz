/**
 * Faits d'une page pour le résumé IA : quelques constats chiffrés par visuel (total, premiers,
 * évolution, sens, écart à la moyenne, cible…), calculés ici à partir des résultats déjà affichés.
 *
 * Seuls ces faits partent vers l'IA (jamais les lignes du jeu de données), et le backend vérifie
 * que chaque nombre de la synthèse en provient : on les écrit donc exactement comme à l'écran.
 *
 * Chaque visuel donne aussi, au plus, un constat rédigé (`Note`) : la matière de la lecture calculée
 * de la page (`reading.ts`), qui sert de repli quand l'IA échoue et de point d'appui quand elle répond.
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
  /** Période dite en clair dans un constat rédigé (« août 2026 » pour « 2026-08 ») ; le fait garde le libellé affiché. */
  say?: string;
}

/** Constat rédigé d'un visuel : une phrase qui compare, situe ou décrit une évolution. */
export interface Note {
  text: string;
  /** Importance relative : la lecture de la page garde les constats les plus lourds. */
  weight: number;
}

/** Valeur unique d'une carte (KPI sans cible) : de quoi rapporter deux mesures de la page l'une à l'autre. */
export interface Single {
  label: string;
  value: number;
  text: string;
  /** Agrégation de la mesure (`sum`, `avg`, `max`…) ; null pour un calcul rapide ou une mesure calculée. */
  agg: string | null;
  field: string;
  /** Unité affichée (préfixe + suffixe) : deux mesures ne se comparent que dans la même unité. */
  unit: string;
}

/** Ce qu'un visuel apporte au résumé : faits (envoyés tels quels), constat rédigé, valeur de carte, période. */
export interface VisualAnalysis {
  facts: string[];
  notes: Note[];
  single?: Single;
  /** Période couverte par l'axe du temps du visuel (« août 2026 → oct. 2026 »). */
  period?: string;
}

interface Part {
  facts: string[];
  note?: Note;
  period?: string;
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

// Additif = somme ou nombre bruts ; un calcul rapide (« @ytd », « @yoy_pct »…) ne s'additionne jamais.
const isAdditive = (key: string) => (key.startsWith("sum(") || key.startsWith("count(")) && !key.includes("@");

/** Format d'une colonne de mesure (pourcentages des calculs rapides compris). */
function fmtOf(visual: Visual, key: string, fallback: NumberFormat): NumberFormat {
  const b = Object.values(visual.roles)
    .flat()
    .find((x) => x.agg && bindingKey(x) === key);
  return b ? numberFormat(visual, b) : fallback;
}
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

/** Montant avec son signe : « +5 k € », « -1,2 k € » (variation entre deux valeurs). */
export function signedAmount(v: number, fmt: NumberFormat): string {
  return `${v > 0 ? "+" : ""}${amount(v, fmt)}`;
}

/** « 3,8 » dans « 3,8 fois la moyenne ». */
const times = (ratio: number) => formatNumber(Math.round(ratio * 10) / 10, { decimals: 1 });

const unitOf = (fmt: NumberFormat) => (fmt.fraction ? "%" : `${fmt.prefix ?? ""}|${fmt.suffix ?? ""}`);

const PERIOD_LABEL = /^\d{4}(-(0[1-9]|1[0-2])(-\d{2})?|-?[TQ][1-4]|-?S[12])?$/;

/** Dimension de texte qui est en fait une période (« 2026-08 », « 2026-T3 », « 2026 ») : à lire dans l'ordre du temps. */
export function isPeriodAxis(entries: Entry[]): boolean {
  return entries.length > 1 && entries.every((e) => typeof e.raw === "string" && PERIOD_LABEL.test(e.raw));
}

/** Période d'un axe de texte dite en clair : « 2026-08 » → « août 2026 », « 2026-T3 » → « T3 2026 ». */
export function spokenPeriod(raw: string): string {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?|-?([TQ])([1-4])|-?S([12]))?$/.exec(raw);
  if (!m) return raw;
  const [, year, month, day, , quarter, half] = m;
  if (quarter) return `T${quarter} ${year}`;
  if (half) return `S${half} ${year}`;
  if (month) return formatDimension(`${year}-${month}-${day ?? "01"}`, "date", day ? null : "month");
  return raw;
}

const said = (e: Entry) => e.say ?? e.label;

export type Direction = "hausse" | "baisse" | "stable";

/** Sens du début à la fin : stable sous 2 % de l'ordre de grandeur de la série. */
export function direction(firstValue: number, lastValue: number, mean: number): Direction {
  const scale = Math.max(Math.abs(firstValue), Math.abs(lastValue), Math.abs(mean));
  if (scale === 0 || Math.abs(lastValue - firstValue) / scale < 0.02) return "stable";
  return lastValue > firstValue ? "hausse" : "baisse";
}

interface Series {
  sorted: Entry[];
  first: Entry;
  last: Entry;
  max: Entry;
  min: Entry;
  total: number;
  mean: number;
  dir: Direction;
  /** Variation relative du début à la fin ; null quand le départ est nul ou négatif (un % n'aurait pas de sens). */
  change: number | null;
}

function seriesOf(entries: Entry[]): Series | null {
  const sorted = [...entries].sort((a, b) => compare(a.raw, b.raw));
  const firstE = sorted[0];
  const lastE = sorted[sorted.length - 1];
  if (!firstE || !lastE) return null;
  const total = sorted.reduce((t, e) => t + e.value, 0);
  const mean = total / sorted.length;
  return {
    sorted,
    first: firstE,
    last: lastE,
    max: sorted.reduce((m, e) => (e.value > m.value ? e : m), firstE),
    min: sorted.reduce((m, e) => (e.value < m.value ? e : m), firstE),
    total,
    mean,
    dir: direction(firstE.value, lastE.value, mean),
    change: sorted.length > 1 && firstE.value > 0 && lastE.value >= 0 ? (lastE.value - firstE.value) / firstE.value : null,
  };
}

/** « Titre » entre guillemets, espaces insécables comprises (le guillemet ne reste jamais seul en fin de ligne). */
export const quoted = (text: string) => `«\u00a0${text}\u00a0»`;

/**
 * Phrase d'une évolution : « CA » est en hausse : de 382 k (janv. 2026) à 566 k (sept. 2026), soit +48 %.
 * `dated = false` pour une deuxième mesure du même graphique : les dates viennent d'être dites.
 */
function movement(subject: string, s: Series, fmt: NumberFormat, dated = true): string {
  const from = `${amount(s.first.value, fmt)}${dated ? ` (${said(s.first)})` : ""}`;
  const to = `${amount(s.last.value, fmt)}${dated ? ` (${said(s.last)})` : ""}`;
  if (s.dir === "stable") return `${quoted(subject)} reste stable : ${from}, puis ${to}`;
  if (s.change === null) return `${quoted(subject)} passe de ${from} à ${to}`;
  return `${quoted(subject)} est en ${s.dir} : de ${from} à ${to}, soit ${percent(s.change, true)}`;
}

/** Constats d'une série temporelle : période, début, fin, évolution, sens, extrêmes, total, moyenne. */
function timeFacts(entries: Entry[], label: string, subject: string, fmt: NumberFormat, additive: boolean): Part {
  const s = seriesOf(entries);
  if (!s) return { facts: [] };
  const n = s.sorted.length;
  const period = `${said(s.first)} → ${said(s.last)}`;
  const out = [`${label} — période : ${s.first.label} → ${s.last.label} (${n} périodes)`];
  out.push(`Début : ${s.first.label} — ${amount(s.first.value, fmt)} ; fin : ${s.last.label} — ${amount(s.last.value, fmt)}`);
  if (n > 1) {
    out.push(
      s.change !== null
        ? `Évolution du début à la fin : ${percent(s.change, true)}`
        : `Variation du début à la fin : ${signedAmount(s.last.value - s.first.value, fmt)}`,
    );
    const ups = s.sorted.filter((e, i) => i > 0 && e.value > (s.sorted[i - 1] as Entry).value).length;
    const downs = s.sorted.filter((e, i) => i > 0 && e.value < (s.sorted[i - 1] as Entry).value).length;
    out.push(`Sens du début à la fin : ${s.dir === "stable" ? "stable" : `en ${s.dir}`}${n > 3 ? ` (${ups} hausses et ${downs} baisses d'une période à la suivante)` : ""}`);
  }
  out.push(`Maximum : ${s.max.label} — ${amount(s.max.value, fmt)} ; minimum : ${s.min.label} — ${amount(s.min.value, fmt)}`);
  if (additive) out.push(`Total sur la période : ${amount(s.total, fmt)}`);
  const vsMean = s.mean > 0 && s.last.value >= 0 && n > 2 ? ` ; la fin est à ${percent((s.last.value - s.mean) / s.mean, true)} de cette moyenne` : "";
  out.push(`Moyenne par période : ${amount(s.mean, fmt)}${vsMean}`);

  let text = movement(subject, s, fmt);
  if (n > 2 && s.max !== s.first && s.max !== s.last) text += ` ; plus haut : ${amount(s.max.value, fmt)} (${said(s.max)})`;
  if (n > 2 && s.min !== s.first && s.min !== s.last) text += ` ; plus bas : ${amount(s.min.value, fmt)} (${said(s.min)})`;
  return { facts: out, period, note: n > 1 ? { text: `${text}.`, weight: s.dir === "stable" ? 1.5 : 3 } : undefined };
}

/** Constats d'un classement : nombre, total, trois premiers avec leur part, dernier, concentration, écart à la moyenne. */
function rankFacts(entries: Entry[], label: string, dimName: string, subject: string, fmt: NumberFormat, additive: boolean): Part {
  const sorted = [...entries].sort((a, b) => b.value - a.value);
  const top = sorted[0];
  if (!top) return { facts: [] };
  const n = sorted.length;
  const total = sorted.reduce((t, e) => t + e.value, 0);
  const mean = total / n;
  const shares = additive && total > 0 && sorted.every((e) => e.value >= 0);
  const share = (e: Entry) => (shares ? ` (${percent(e.value / total)} du total)` : "");
  const out = [`${label} par ${dimName} : ${n} valeur${n > 1 ? "s" : ""}`];
  if (additive) out.push(`Total : ${amount(total, fmt)}`);
  sorted.slice(0, 3).forEach((e, i) => out.push(`${ordinal(i)} : ${e.label} — ${amount(e.value, fmt)}${share(e)}`));
  const last = sorted[n - 1];
  if (last && n > 3) out.push(`Dernier : ${last.label} — ${amount(last.value, fmt)}${share(last)}`);
  const top3 = sorted.slice(0, 3).reduce((t, e) => t + e.value, 0);
  if (shares && n > 3) out.push(`Les 3 premiers ensemble : ${percent(top3 / total)} du total`);
  if (!additive && n > 1) out.push(`Moyenne des ${dimName} : ${amount(mean, fmt)}`);
  // Écart à la moyenne : dit en « fois » quand le premier domine, en % sinon.
  const ratio = mean > 0 ? top.value / mean : 0;
  const lead = ratio >= 2 ? `vaut ${times(ratio)} fois cette moyenne` : ratio > 1 ? `est à ${percent(ratio - 1, true)} de cette moyenne` : "";
  if (additive && n > 2 && lead) out.push(`Moyenne par ${dimName} : ${amount(mean, fmt)} ; le 1er ${lead}`);

  let text: string;
  if (n === 1) text = `${quoted(subject)} : une seule valeur, ${top.label} (${amount(top.value, fmt)})`;
  else if (shares) {
    text = `${top.label} arrive en tête de ${quoted(subject)} avec ${amount(top.value, fmt)}, soit ${percent(top.value / total)} du total`;
    const second = sorted[1] as Entry;
    text +=
      n > 3
        ? ` ; les 3 premiers (${sorted.slice(0, 3).map((e) => e.label).join(", ")}) en font ${percent(top3 / total)}`
        : ` ; ${second.label} suit avec ${amount(second.value, fmt)}`; // en valeur : deux parts arrondies à part dépasseraient 100 % (88 % + 13 %)
  } else {
    const low = sorted[n - 1] as Entry;
    text = `${quoted(subject)} : ${top.label} est le plus haut (${amount(top.value, fmt)}), ${low.label} le plus bas (${amount(low.value, fmt)}) ; moyenne : ${amount(mean, fmt)}`;
  }
  return { facts: out, note: { text: `${text}.`, weight: n === 1 ? 0.5 : 2 + (shares ? top.value / total : 0) } };
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

/** Deuxième mesure d'un graphique : son total, son évolution, et son rapport à la première. */
function secondMeasure(rows: Row[], d0: QueryColumn, chrono: boolean, m1: QueryColumn, m2: QueryColumn, label1: string, label2: string, fmt1: NumberFormat, fmt2: NumberFormat): Part {
  const out: string[] = [];
  let note: string | undefined;
  const additive = isAdditive(m2.key);
  const total2 = rows.reduce((t, r) => t + Number(r[m2.key] ?? 0), 0);
  if (additive) out.push(`Total ${label2} : ${amount(total2, fmt2)}`);
  const s = chrono ? seriesOf(groupBy(rows, d0, m2)) : null;
  if (s && s.sorted.length > 1) {
    const evolution = s.change !== null ? ` ; évolution : ${percent(s.change, true)}` : "";
    out.push(`${label2} — début : ${s.first.label} — ${amount(s.first.value, fmt2)} ; fin : ${s.last.label} — ${amount(s.last.value, fmt2)}${evolution}`);
    note = movement(label2, s, fmt2, false);
  }
  const total1 = rows.reduce((t, r) => t + Number(r[m1.key] ?? 0), 0);
  if (additive && isAdditive(m1.key) && unitOf(fmt1) === unitOf(fmt2) && total1 > 0 && total2 > 0) {
    out.push(`${label2} rapporté à ${label1} (totaux) : ${percent(total2 / total1)}`);
  }
  return { facts: out, note: note ? { text: note, weight: 0 } : undefined };
}

function genericFacts(visual: Visual, result: QueryResult, fmt: NumberFormat, title: string): VisualAnalysis {
  const dims = result.columns.filter((c) => c.role === "dimension");
  const meas = result.columns.filter((c) => c.role === "measure");
  const m = meas[0];
  if (!m || !result.rows.length) return { facts: [], notes: [] };
  const label = measureLabel(visual, m);
  if (!dims.length) {
    return { facts: meas.slice(0, 4).map((c) => `${measureLabel(visual, c)} : ${amount(Number(result.rows[0]?.[c.key] ?? 0), fmt)}`), notes: [] };
  }

  const d0 = dims[0] as QueryColumn;
  const additive = isAdditive(m.key);
  const entries = groupBy(result.rows, d0, m);
  const chrono = d0.type === "date" || isPeriodAxis(entries);
  if (chrono && d0.type !== "date") for (const e of entries) e.say = spokenPeriod(String(e.raw));
  const m2 = meas[1];
  // Avec deux mesures, le titre du visuel les nomme toutes les deux : chaque phrase parle alors de sa mesure.
  const subject = m2 ? label : title;
  const fmt1 = fmtOf(visual, m.key, fmt);
  const part = chrono ? timeFacts(entries, label, subject, fmt1, additive) : rankFacts(entries, label, dimensionLabel(visual, d0), subject, fmt1, additive);
  const out = [...part.facts];
  let note = part.note;
  const d1 = dims[1];
  if (d1) {
    const s = seriesFact(result.rows, d1, m, dimensionLabel(visual, d1), fmt1);
    if (s) out.push(s);
  }
  if (m2) {
    const second = secondMeasure(result.rows, d0, chrono, m, m2, label, measureLabel(visual, m2), fmt1, fmtOf(visual, m2.key, fmt));
    out.push(...second.facts);
    if (note && second.note) note = { ...note, text: `${note.text.replace(/\.$/, "")} ; ${second.note.text}.` };
  }
  if (result.truncated) out.push("Résultat partiel (limite de lignes atteinte)");
  return { facts: out, notes: note ? [note] : [], period: part.period };
}

function kpiFacts(visual: Visual, data: FactsData, fmt: NumberFormat, title: string): VisualAnalysis {
  const valueB = first(visual, "values");
  const targetB = first(visual, "target");
  const row = data.result?.rows[0];
  if (!valueB || !row) return { facts: [], notes: [] };
  const value = Number(row[bindingKey(valueB)] ?? 0);
  const label = bindingLabel(valueB);
  const out = [`${label} : ${amount(value, fmt)}`];
  const notes: Note[] = [];
  const fixed = typeof visual.options.target === "number" ? visual.options.target : null;
  const target = targetB ? Number(row[bindingKey(targetB)] ?? 0) : fixed;
  const gap = kpiGap(value, target);
  if (target !== null && gap !== null) {
    const higherIsBetter = opt<boolean>(visual, VISUALS[visual.type], "higherIsBetter") !== false;
    const good = higherIsBetter ? gap >= 0 : gap <= 0;
    out.push(`Cible : ${amount(target, fmt)} ; écart : ${percent(gap / 100, true)} (${good ? "favorable" : "défavorable"})`);
    notes.push({
      text: `${quoted(title)} : ${amount(value, fmt)} pour une cible de ${amount(target, fmt)}, soit un écart ${good ? "favorable" : "défavorable"} de ${percent(gap / 100, true)}.`,
      weight: good ? 3.2 : 3.8,
    });
  }
  if (visual.type === "gauge") {
    const max = typeof visual.options.max === "number" ? visual.options.max : null;
    if (max !== null) out.push(`Plage de la jauge : ${amount(Number(visual.options.min ?? 0), fmt)} à ${amount(max, fmt)}`);
  }
  let period: string | undefined;
  const trend = data.trend;
  if (trend && trend.rows.length > 1) {
    const dim = trend.columns.find((c) => c.role === "dimension");
    const m = trend.columns.find((c) => c.role === "measure");
    if (dim && m) {
      const part = timeFacts(groupBy(trend.rows, dim, m), "Tendance", title, fmt, isAdditive(m.key));
      out.push(...part.facts.slice(1, 4));
      period = part.period;
      if (part.note && !notes.length) notes.push({ ...part.note, weight: part.note.weight - 0.8 });
    }
  }
  const single: Single | undefined =
    target === null && visual.type === "kpi"
      ? { label, value, text: amount(value, fmt), agg: valueB.show ? null : (valueB.agg ?? null), field: valueB.field, unit: unitOf(fmt) }
      : undefined;
  return { facts: out, notes, single, period };
}

function matrixFacts(visual: Visual, result: QueryResult, title: string): VisualAnalysis {
  const rows = role(visual, "rows");
  const values = role(visual, "values");
  const column = first(visual, "columns");
  const m = values[0];
  const r0 = rows[0];
  if (!m || !r0) return { facts: [], notes: [] };
  const model = buildMatrix(result.rows, rows, column);
  const key = bindingKey(m);
  const entries: Entry[] = model.root.children.map((n) => ({
    raw: n.value,
    label: formatDimension(n.value, undefined, r0.bin),
    value: Number(n.cells.get("__total")?.[key] ?? 0),
  }));
  const additive = isAdditive(key);
  const mf = numberFormat(visual, m);
  const part = rankFacts(entries, bindingLabel(m), r0.label || r0.field, title, mf, additive);
  const out = [...part.facts];
  const total = model.root.cells.get("__total")?.[key];
  if (total != null && !additive) out.push(`Ensemble : ${amount(Number(total), mf)}`);
  return { facts: out, notes: part.note ? [part.note] : [] };
}

/** Total d'une mesure additive d'un tableau. */
interface TableTotal {
  label: string;
  value: number;
  text: string;
  unit: string;
  /** Moyenne par ligne, telle qu'affichée. */
  mean: string;
}

/**
 * Constat d'un tableau : son nombre de lignes et ses totaux, rapportés entre eux (jamais une de ses lignes).
 * Sans lui, une page faite d'un seul tableau n'aurait aucune lecture calculée, donc aucun repli.
 */
function tableNote(title: string, count: string, n: number, exact: boolean, totals: TableTotal[]): Note {
  const head = `${quoted(title)} compte ${count}`;
  const positive = totals.filter((t) => t.value > 0).sort((a, b) => b.value - a.value);
  const base = positive[0];
  const other = positive.find((t) => base && t !== base && t.unit === base.unit && t.value < base.value);
  if (base && other) {
    return { text: `${head} ; ${quoted(other.label)} (${other.text}) y représente ${percent(other.value / base.value)} de ${quoted(base.label)} (${base.text}).`, weight: 1.6 };
  }
  const total = totals[0];
  if (total) {
    const mean = exact && n > 1 && total.value > 0 ? `, soit ${total.mean} par ligne en moyenne` : "";
    return { text: `${head}, pour un total ${quoted(total.label)} de ${total.text}${mean}.`, weight: 1.2 };
  }
  return { text: `${head}.`, weight: 0.4 };
}

function tableFacts(visual: Visual, result: QueryResult, fmt: NumberFormat, title: string): VisualAnalysis {
  const dims = result.columns.filter((c) => c.role === "dimension");
  const meas = result.columns.filter((c) => c.role === "measure");
  const n = result.rows.length;
  const count = `${result.truncated ? "plus de " : ""}${formatNumber(n)} ligne${n > 1 ? "s" : ""}`;
  const out = [`${n}${result.truncated ? " (ou plus)" : ""} lignes`];
  const totals: TableTotal[] = [];
  for (const c of meas.slice(0, 3)) {
    if (!isAdditive(c.key)) continue;
    const f = fmtOf(visual, c.key, fmt);
    const value = result.rows.reduce((t, r) => t + Number(r[c.key] ?? 0), 0);
    const label = measureLabel(visual, c);
    totals.push({ label, value, text: amount(value, f), unit: unitOf(f), mean: amount(n ? value / n : 0, f) });
    out.push(`Total ${label} : ${amount(value, f)}`);
  }
  const m = meas[0];
  const d0 = dims[0];
  if (m && d0) {
    const f = fmtOf(visual, m.key, fmt);
    const label = measureLabel(visual, m);
    if (dims.length === 1) {
      // Une seule colonne de regroupement : chaque ligne est un agrégat par valeur, comme la barre d'un graphique.
      const top = [...result.rows].sort((a, b) => Number(b[m.key] ?? 0) - Number(a[m.key] ?? 0)).slice(0, 3);
      top.forEach((r, i) => out.push(`${ordinal(i)} (${label}) : ${dimText(r, d0)} — ${amount(Number(r[m.key] ?? 0), f)}`));
    } else if (isAdditive(m.key)) {
      // Plusieurs colonnes : une ligne du tableau est (presque) une ligne du jeu de données — date, libellé,
      // catégorie, montant. Elle ne part jamais vers l'IA. Seul un classement par la première colonne est dit,
      // et seulement s'il regroupe vraiment (deux lignes par valeur en moyenne) : sinon ce serait encore une ligne.
      const groups = groupBy(result.rows, d0, m).sort((a, b) => b.value - a.value);
      if (groups.length > 1 && groups.length * 2 <= n) {
        const by = dimensionLabel(visual, d0);
        groups.slice(0, 3).forEach((e, i) => out.push(`${ordinal(i)} par ${by} (${label}) : ${e.label} — ${amount(e.value, f)}`));
      }
    }
  }
  return { facts: out, notes: [tableNote(title, count, n, !result.truncated, totals)] };
}

function scatterFacts(visual: Visual, result: QueryResult, fmt: NumberFormat, title: string): VisualAnalysis {
  const d = first(visual, "details");
  const y = first(visual, "y");
  const x = first(visual, "x");
  if (!d || !y || !x) return { facts: [], notes: [] };
  const rows = result.rows.filter((r) => r[bindingKey(y)] != null);
  const top = [...rows].sort((a, b) => Number(b[bindingKey(y)] ?? 0) - Number(a[bindingKey(y)] ?? 0))[0];
  const out = [`${rows.length} points (un par ${d.field}) ; X = ${bindingLabel(x)}, Y = ${bindingLabel(y)}`];
  let text = `${quoted(title)} compare ${formatNumber(rows.length)} point${rows.length > 1 ? "s" : ""} (un par ${d.field})`;
  if (top) {
    const name = String(top[bindingKey(d)] ?? "(Vide)");
    const value = amount(Number(top[bindingKey(y)] ?? 0), fmt);
    out.push(`Plus haut ${bindingLabel(y)} : ${name} — ${value}`);
    if (rows.length > 1) text += ` ; ${name} a le plus haut ${quoted(bindingLabel(y))} (${value})`;
  }
  return { facts: out, notes: [{ text: `${text}.`, weight: 1 }] };
}

/** Carte à points : le nombre de points placés (leurs coordonnées ne sont pas des chiffres à lire). */
function pointMapFacts(result: QueryResult, title: string): VisualAnalysis {
  const n = result.rows.length;
  return { facts: [`${n} points sur la carte`], notes: [{ text: `${quoted(title)} place ${formatNumber(n)} point${n > 1 ? "s" : ""} sur la carte.`, weight: 0.4 }] };
}

const EMPTY: VisualAnalysis = { facts: [], notes: [] };

/** Tout ce qu'un visuel apporte au résumé : faits chiffrés, constat rédigé, valeur de carte, période. */
export function analyzeVisual(visual: Visual, data: FactsData): VisualAnalysis {
  visual = drillView(visual); // faits du niveau d'exploration affiché
  if (SKIPPED.has(visual.type) || data.error || !data.result) return EMPTY;
  const fmt = numberFormat(visual);
  const title = visual.title || defaultTitle(visual);
  let found: VisualAnalysis;
  switch (visual.type) {
    case "kpi":
    case "gauge":
      found = kpiFacts(visual, data, fmt, title);
      break;
    case "matrix":
      found = matrixFacts(visual, data.result, title);
      break;
    case "table":
      found = tableFacts(visual, data.result, fmt, title);
      break;
    case "scatter":
      found = scatterFacts(visual, data.result, fmt, title);
      break;
    case "pointmap":
      found = pointMapFacts(data.result, title);
      break;
    default:
      found = genericFacts(visual, data.result, fmt, title);
  }
  return { ...found, facts: found.facts.slice(0, MAX_FACTS).map((f) => f.slice(0, 300)) };
}

/** Constats chiffrés d'un visuel (liste vide si le visuel n'apporte pas de chiffre). */
export function visualFacts(visual: Visual, data: FactsData): string[] {
  return analyzeVisual(visual, data).facts;
}

/** Visuels chiffrés d'une page, chacun avec son analyse (30 au plus ; deux visuels des mêmes données : un seul). */
export function pageAnalyses(page: Page, dataOf: (visualId: string) => FactsData | undefined): { visual: Visual; title: string; analysis: VisualAnalysis }[] {
  const out: { visual: Visual; title: string; analysis: VisualAnalysis }[] = [];
  const seen = new Set<string>();
  for (const v of page.visuals) {
    const data = dataOf(v.id);
    if (!data) continue;
    const analysis = analyzeVisual(v, data);
    // Deux visuels des mêmes données (carte et barres du CA par région) : faits envoyés une seule fois.
    const key = analysis.facts.join("\n");
    if (!analysis.facts.length || seen.has(key)) continue;
    seen.add(key);
    out.push({ visual: v, title: (v.title || defaultTitle(v)).slice(0, 200), analysis });
  }
  return out.slice(0, 30);
}

/** Faits de toute la page, pour la requête de résumé (30 visuels au plus). */
export function pageFacts(page: Page, dataOf: (visualId: string) => FactsData | undefined): VisualFacts[] {
  return pageAnalyses(page, dataOf).map(({ visual, title, analysis }) => ({ id: visual.id, title, type: visual.type, facts: analysis.facts }));
}
