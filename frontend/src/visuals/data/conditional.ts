/**
 * Mise en forme conditionnelle des tables et matrices (comme Power BI) : par mesure, une échelle de
 * couleurs (séquentielle ou divergente), des règles (« > 1000 → vert »), des barres de données et
 * des icônes ▲ ● ▼.
 *
 * Logique pure : `decorate` décrit la mise en forme d'une cellule, `decorStyle` la traduit en CSS
 * (variables de thème) pour l'écran, `decorHex` en couleurs hexadécimales pour PowerPoint.
 * Le texte reste à l'encre neutre ; les fonds sont des teintes légères (≤ 55 %) pour rester lisibles.
 */

import type { CSSProperties } from "react";

import { blend } from "../../theme/color";
import type { ScaleColors } from "../../theme/scales";
import type { Visual } from "../../types/report";

export type RuleOp = "gt" | "gte" | "lt" | "lte" | "eq" | "between";
export type RuleColor = "positive" | "negative" | "accent" | "muted";

export interface CondRule {
  op: RuleOp;
  value: number;
  /** Borne haute de « entre ». */
  value2?: number | null;
  color: RuleColor;
}

export interface CondFormat {
  /** Fond en dégradé selon la valeur. */
  scale: "none" | "sequential" | "diverging";
  /** Règles, la première vérifiée l'emporte sur l'échelle. */
  rules: CondRule[];
  /** Les règles colorent le fond ou le texte. */
  rulesTarget: "background" | "text";
  bars: boolean;
  icons: "none" | "sign" | "terciles";
}

export const EMPTY_FORMAT: CondFormat = { scale: "none", rules: [], rulesTarget: "background", bars: false, icons: "none" };

export const RULE_OPS: { value: RuleOp; label: string }[] = [
  { value: "gt", label: ">" },
  { value: "gte", label: "≥" },
  { value: "lt", label: "<" },
  { value: "lte", label: "≤" },
  { value: "eq", label: "=" },
  { value: "between", label: "entre" },
];

export const RULE_COLORS: { value: RuleColor; label: string }[] = [
  { value: "positive", label: "Vert" },
  { value: "negative", label: "Rouge" },
  { value: "accent", label: "Bleu" },
  { value: "muted", label: "Gris" },
];

/** Intensités minimale et maximale d'un fond (part de couleur mêlée au fond du visuel). */
export const MIN_TINT = 0.08;
export const MAX_TINT = 0.55;
export const RULE_TINT = 0.28;

/** Mise en forme d'une mesure (clé `agg(champ)`) ; l'ancienne option « Barres de données » vaut pour toutes. */
export function formatFor(visual: Visual, measureKey: string): CondFormat {
  const all = visual.options.conditional as Record<string, Partial<CondFormat>> | undefined;
  const own = all?.[measureKey];
  const legacyBars = visual.options.dataBars === true;
  return { ...EMPTY_FORMAT, bars: legacyBars, ...own, rules: Array.isArray(own?.rules) ? own.rules : [] };
}

/** Vrai si la mesure a au moins une mise en forme. */
export function isFormatted(f: CondFormat): boolean {
  return f.scale !== "none" || f.rules.length > 0 || f.bars || f.icons !== "none";
}

export interface Stats {
  min: number;
  max: number;
  /** Bornes des tiers (33e et 67e centiles). */
  low: number;
  high: number;
  /** Plus grande valeur absolue (barres). */
  absMax: number;
}

/** Statistiques des valeurs affichées d'une mesure (valeurs manquantes ignorées). */
export function statsOf(values: (number | null | undefined)[]): Stats | null {
  const xs = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const q = (p: number) => xs[Math.min(xs.length - 1, Math.max(0, Math.round(p * (xs.length - 1))))] as number;
  return { min: xs[0] as number, max: xs[xs.length - 1] as number, low: q(1 / 3), high: q(2 / 3), absMax: Math.max(...xs.map(Math.abs)) || 1 };
}

export function ruleMatches(rule: CondRule, v: number): boolean {
  switch (rule.op) {
    case "gt":
      return v > rule.value;
    case "gte":
      return v >= rule.value;
    case "lt":
      return v < rule.value;
    case "lte":
      return v <= rule.value;
    case "eq":
      return v === rule.value;
    case "between": {
      const hi = rule.value2 ?? rule.value;
      return v >= Math.min(rule.value, hi) && v <= Math.max(rule.value, hi);
    }
  }
}

export type Tone = "seq" | "div-pos" | "div-neg" | RuleColor;

export interface Decor {
  fill?: { tone: Tone; tint: number };
  text?: RuleColor;
  bar?: { ratio: number; negative: boolean };
  icon?: { glyph: "up" | "flat" | "down"; tone: "positive" | "muted" | "negative"; label: string };
}

const tint = (t: number) => MIN_TINT + Math.max(0, Math.min(1, t)) * (MAX_TINT - MIN_TINT);

/** Mise en forme d'une cellule ; `stats` = valeurs affichées de la même mesure. */
export function decorate(v: number | null | undefined, f: CondFormat, stats: Stats | null): Decor {
  if (typeof v !== "number" || !Number.isFinite(v) || !stats) return {};
  const d: Decor = {};
  if (f.scale === "sequential") {
    const span = stats.max - stats.min;
    d.fill = { tone: "seq", tint: tint(span > 0 ? (v - stats.min) / span : 1) };
  } else if (f.scale === "diverging") {
    // Centre : zéro si les valeurs le traversent, sinon le milieu de l'étendue.
    const center = stats.min < 0 && stats.max > 0 ? 0 : (stats.min + stats.max) / 2;
    const reach = Math.max(stats.max - center, center - stats.min) || 1;
    const t = Math.abs(v - center) / reach;
    d.fill = { tone: v >= center ? "div-pos" : "div-neg", tint: t < 0.02 ? 0 : tint(t) };
  }
  const rule = f.rules.find((r) => ruleMatches(r, v));
  if (rule) {
    if (f.rulesTarget === "text") d.text = rule.color;
    else d.fill = { tone: rule.color, tint: RULE_TINT };
  }
  if (f.bars) d.bar = { ratio: Math.min(1, Math.abs(v) / stats.absMax), negative: v < 0 };
  if (f.icons === "sign") {
    d.icon = v > 0 ? { glyph: "up", tone: "positive", label: "positif" } : v < 0 ? { glyph: "down", tone: "negative", label: "négatif" } : { glyph: "flat", tone: "muted", label: "nul" };
  } else if (f.icons === "terciles") {
    d.icon =
      v >= stats.high && stats.high > stats.low
        ? { glyph: "up", tone: "positive", label: "tiers haut" }
        : v <= stats.low && stats.high > stats.low
          ? { glyph: "down", tone: "negative", label: "tiers bas" }
          : { glyph: "flat", tone: "muted", label: "tiers médian" };
  }
  return d;
}

export const GLYPHS = { up: "▲", flat: "●", down: "▼" } as const;

const CSS_TONE: Record<Tone, string> = {
  seq: "var(--seq-500)",
  "div-pos": "var(--div-pos)",
  "div-neg": "var(--div-neg)",
  positive: "var(--cond-pos)",
  negative: "var(--cond-neg)",
  accent: "var(--cond-blue)",
  muted: "var(--cond-grey)",
};

/** Styles CSS d'une cellule (fond teinté, couleur de texte des règles). */
export function decorStyle(d: Decor): CSSProperties {
  const style: CSSProperties = {};
  if (d.fill && d.fill.tint > 0) style.backgroundColor = `color-mix(in oklab, ${CSS_TONE[d.fill.tone]} ${Math.round(d.fill.tint * 100)}%, transparent)`;
  if (d.text) style.color = CSS_TONE[d.text];
  return style;
}

/** Couleur CSS d'un ton (icônes, barres). */
export function toneCss(tone: Tone): string {
  return CSS_TONE[tone];
}

function toneHex(tone: Tone, c: ScaleColors): string {
  switch (tone) {
    case "seq":
      return c.seq;
    case "div-pos":
      return c.divPos;
    case "div-neg":
      return c.divNeg;
    default:
      return c[tone];
  }
}

/** Couleurs hexadécimales (export) : fond mêlé à la surface du visuel, texte des règles, icône. */
export function decorHex(d: Decor, c: ScaleColors, surface: string): { fill?: string; text?: string; icon?: string } {
  return {
    fill: d.fill && d.fill.tint > 0 ? blend(toneHex(d.fill.tone, c), surface, d.fill.tint) : undefined,
    text: d.text ? toneHex(d.text, c) : undefined,
    icon: d.icon ? toneHex(d.icon.tone, c) : undefined,
  };
}
