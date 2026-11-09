/**
 * Ligne de tendance et prévision des graphiques cartésiens (courbes, aires, histogramme).
 *
 * Calcul local, transparent et reproductible : régression linéaire par moindres carrés sur le rang
 * des catégories (0, 1, 2…), comme la « ligne de tendance » de Power BI ou d'Excel. La prévision
 * prolonge cette droite sur N périodes d'un axe de dates regroupé (mois, trimestre…) avec un
 * intervalle de prévision à 95 % (loi de Student) : plus on s'éloigne, plus il s'élargit.
 *
 * Les valeurs projetées ne sont jamais des données : elles ne partent ni dans l'export des données,
 * ni dans les faits envoyés à l'IA (résumé, questions), qui lisent le résultat de la requête.
 */

import type { ColumnType, Scalar } from "../../types/dataset";
import type { DateBin } from "../../types/query";
import { formatDimension, parseDate } from "../format";
import type { Datum, SeriesDef } from "./series";

export interface LinearFit {
  slope: number;
  intercept: number;
  /** Nombre de points utilisés. */
  n: number;
  /** Écart type des résidus (n − 2 degrés de liberté). */
  sigma: number;
  xMean: number;
  /** Σ (x − x̄)². */
  sxx: number;
  /** Coefficient de détermination R². */
  r2: number;
}

/** Nombre minimal de points pour une tendance (et 4 pour une prévision). */
export const MIN_POINTS = 3;
export const MAX_FORECAST = 24;

/** Régression linéaire y = a·x + b sur les points non vides (x = rang), ou null si moins de 3 points. */
export function linearFit(values: readonly (number | null)[]): LinearFit | null {
  const pts = values.flatMap((y, x) => (y !== null && Number.isFinite(y) ? [[x, y] as const] : []));
  const n = pts.length;
  if (n < MIN_POINTS) return null;
  const xMean = pts.reduce((s, [x]) => s + x, 0) / n;
  const yMean = pts.reduce((s, [, y]) => s + y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const [x, y] of pts) {
    sxx += (x - xMean) ** 2;
    sxy += (x - xMean) * (y - yMean);
    syy += (y - yMean) ** 2;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = yMean - slope * xMean;
  const sse = pts.reduce((s, [x, y]) => s + (y - (slope * x + intercept)) ** 2, 0);
  const sigma = n > 2 ? Math.sqrt(sse / (n - 2)) : 0;
  const r2 = syy === 0 ? 1 : Math.max(0, 1 - sse / syy);
  return { slope, intercept, n, sigma, xMean, sxx, r2 };
}

/** Quantile 97,5 % de la loi de Student (intervalle à 95 %), selon les degrés de liberté. */
export function student975(df: number): number {
  const table = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086];
  if (df < 1) return Number.NaN;
  if (df <= table.length) return table[df - 1] ?? 1.96;
  if (df <= 30) return 2.042;
  if (df <= 60) return 2.0;
  return 1.96;
}

/** Valeur ajustée et demi-largeur de l'intervalle de prévision à 95 % au rang x. */
export function predict(fit: LinearFit, x: number): { value: number; margin: number } {
  const value = fit.slope * x + fit.intercept;
  const margin = student975(fit.n - 2) * fit.sigma * Math.sqrt(1 + 1 / fit.n + (x - fit.xMean) ** 2 / fit.sxx);
  return { value, margin: Number.isFinite(margin) ? margin : 0 };
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** Périodes qui suivent `last` sur un axe de dates regroupé (dates ISO), ou [] si ce n'est pas une date. */
export function nextPeriods(last: Scalar, bin: DateBin | null | undefined, count: number): string[] {
  const start = parseDate(last);
  if (!start || !bin || count <= 0) return [];
  const out: string[] = [];
  for (let i = 1; i <= count; i++) {
    const d = new Date(start);
    if (bin === "year") d.setFullYear(start.getFullYear() + i);
    else if (bin === "quarter") d.setMonth(start.getMonth() + 3 * i);
    else if (bin === "month") d.setMonth(start.getMonth() + i);
    else if (bin === "week") d.setDate(start.getDate() + 7 * i);
    else d.setDate(start.getDate() + i);
    out.push(iso(d));
  }
  return out;
}

export interface TrendOptions {
  trend: boolean;
  /** Nombre de périodes à prévoir (0 = aucune). */
  forecast: number;
  catType: ColumnType | undefined;
  bin: DateBin | null | undefined;
  /** Prévision saisonnière (mois, trimestre, semaine, jour) quand deux cycles complets sont connus. */
  seasonal?: boolean;
}

/** Longueur du cycle saisonnier d'un regroupement de dates (année : aucun). */
export function seasonPeriod(bin: DateBin | null | undefined): number | null {
  return bin === "month" ? 12 : bin === "quarter" ? 4 : bin === "week" ? 52 : bin === "day" ? 7 : null;
}

/** Position d'une date dans son cycle : mois 0-11, trimestre 0-3, semaine 0-51, jour de semaine 0-6. */
export function seasonOf(value: Scalar, bin: DateBin | null | undefined): number | null {
  const d = parseDate(value);
  if (!d) return null;
  if (bin === "month") return d.getMonth();
  if (bin === "quarter") return Math.floor(d.getMonth() / 3);
  if (bin === "day") return d.getDay();
  if (bin === "week") {
    const start = new Date(d.getFullYear(), 0, 1);
    return Math.min(51, Math.floor((d.getTime() - start.getTime()) / (7 * 86_400_000)));
  }
  return null;
}

export interface SeasonalModel {
  period: number;
  /** Écart moyen à la tendance de chaque position du cycle (somme nulle). */
  indices: number[];
  /** Écart type des résidus une fois tendance et saisons retirées. */
  sigma: number;
  /** Degrés de liberté de ces résidus. */
  df: number;
}

/**
 * Indices saisonniers additifs (moyenne des écarts à la droite par position du cycle), seulement si
 * chaque position est observée au moins deux fois et qu'il reste des degrés de liberté ; sinon null.
 */
export function seasonalModel(values: readonly (number | null)[], seasons: readonly (number | null)[], period: number, fit: LinearFit): SeasonalModel | null {
  const sums = new Array<number>(period).fill(0);
  const counts = new Array<number>(period).fill(0);
  const points: [number, number, number][] = [];
  values.forEach((y, x) => {
    const k = seasons[x];
    if (y === null || !Number.isFinite(y) || k === null || k === undefined) return;
    const r = y - (fit.slope * x + fit.intercept);
    sums[k] = (sums[k] ?? 0) + r;
    counts[k] = (counts[k] ?? 0) + 1;
    points.push([x, y, k]);
  });
  if (counts.some((c) => c < 2)) return null;
  const raw = sums.map((s, k) => s / (counts[k] ?? 1));
  const mean = raw.reduce((a, b) => a + b, 0) / period;
  const indices = raw.map((v) => v - mean);
  const df = points.length - 2 - (period - 1);
  if (df < 1) return null;
  const sse = points.reduce((t, [x, y, k]) => t + (y - (fit.slope * x + fit.intercept) - (indices[k] ?? 0)) ** 2, 0);
  return { period, indices, sigma: Math.sqrt(sse / df), df };
}

/** Série ajoutée au graphique (tendance, prévision ou intervalle), avec la série dont elle dérive. */
export interface DerivedSeries {
  key: string;
  kind: "trend" | "forecast" | "band";
  source: SeriesDef;
  /** R² de la droite (tendance) — affiché dans l'info-bulle. */
  r2: number;
  /** Prévision avec saisonnalité (sinon droite seule, faute de deux cycles complets). */
  seasonal?: boolean;
}

/** Point du graphique : données d'origine + tendance, prévision et intervalle [bas, haut]. */
export interface TrendDatum {
  __cat: Scalar;
  __label: string;
  [key: string]: Scalar | [number, number];
}

export interface WithTrend {
  data: TrendDatum[];
  derived: DerivedSeries[];
  /** Libellé de la première période prévue (zone grisée), ou null. */
  forecastStart: string | null;
}

export const trendKey = (key: string) => `t:${key}`;
export const forecastKey = (key: string) => `f:${key}`;
export const bandKey = (key: string) => `b:${key}`;

/**
 * Ajoute aux données les valeurs de tendance (`t:<série>`), de prévision (`f:<série>`, raccordée au
 * dernier point réel) et l'intervalle à 95 % (`b:<série>` = [bas, haut]), plus les périodes futures.
 * Les données d'origine ne sont pas modifiées.
 */
export function withTrend(data: Datum[], series: SeriesDef[], opts: TrendOptions): WithTrend {
  const horizon = Math.max(0, Math.min(MAX_FORECAST, Math.floor(opts.forecast)));
  const future = opts.catType === "date" && data.length >= MIN_POINTS + 1 ? nextPeriods(data[data.length - 1]?.__cat ?? null, opts.bin, horizon) : [];
  if (!opts.trend && !future.length) return { data: data.map((d) => ({ ...d })), derived: [], forecastStart: null };

  const rows: TrendDatum[] = data.map((d) => ({ ...d }));
  const extra: TrendDatum[] = future.map((cat) => ({ __cat: cat, __label: formatDimension(cat, "date", opts.bin), __forecast: true }));
  const derived: DerivedSeries[] = [];
  const lastIndex = rows.length - 1;

  for (const s of series) {
    const values = rows.map((d) => {
      const v = d[s.key];
      if (typeof v === "number") return v;
      if (typeof v !== "string" || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    });
    const fit = linearFit(values);
    if (!fit) continue;
    if (opts.trend) {
      rows.forEach((d, x) => (d[trendKey(s.key)] = fit.slope * x + fit.intercept));
      derived.push({ key: trendKey(s.key), kind: "trend", source: s, r2: fit.r2 });
    }
    if (future.length) {
      // Raccord : la prévision part du dernier point réel (intervalle nul à cet endroit).
      const last = rows[lastIndex];
      const lastValue = values[lastIndex];
      if (last && lastValue !== null && lastValue !== undefined) {
        last[forecastKey(s.key)] = lastValue;
        last[bandKey(s.key)] = [lastValue, lastValue];
      }
      const period = opts.seasonal ? seasonPeriod(opts.bin) : null;
      const season = period ? seasonalModel(values, rows.map((d) => seasonOf(d.__cat, opts.bin)), period, fit) : null;
      extra.forEach((d, i) => {
        const x = lastIndex + 1 + i;
        const p = predict(fit, x);
        let value = p.value;
        let margin = p.margin;
        if (season) {
          // Saison de la période prévue + intervalle fondé sur les résidus désaisonnalisés.
          value += season.indices[seasonOf(d.__cat, opts.bin) ?? 0] ?? 0;
          margin = student975(season.df) * season.sigma * Math.sqrt(1 + 1 / fit.n + (x - fit.xMean) ** 2 / fit.sxx);
        }
        d[forecastKey(s.key)] = value;
        d[bandKey(s.key)] = [value - margin, value + margin];
      });
      derived.push({ key: forecastKey(s.key), kind: "forecast", source: s, r2: fit.r2, seasonal: season !== null });
      derived.push({ key: bandKey(s.key), kind: "band", source: s, r2: fit.r2, seasonal: season !== null });
    }
  }
  const hasForecast = derived.some((d) => d.kind === "forecast");
  return {
    data: hasForecast ? [...rows, ...extra] : rows,
    derived,
    forecastStart: hasForecast ? (extra[0]?.__label ?? null) : null,
  };
}

/** La tendance a-t-elle un sens pour ce visuel (axe trié par catégorie, ni empilé ni 100 %) ? */
export function trendApplies(options: { sort?: unknown; stacked?: unknown; percent?: unknown }): boolean {
  return (options.sort === undefined || options.sort === "category") && options.stacked !== true && options.percent !== true;
}
