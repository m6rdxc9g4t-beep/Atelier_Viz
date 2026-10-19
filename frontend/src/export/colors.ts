/**
 * Couleurs de l'export : PowerPoint ne connaît pas les variables CSS, on résout donc le thème
 * du rapport (et les surcharges de chaque visuel) en hexadécimaux, sans « # » (format pptxgenjs).
 *
 * Mêmes règles que `themeVars` / `visualCss` : un visuel exporté a les couleurs de l'écran.
 */

import { blend, isDarkColor, isHex, normalizeHex } from "../theme/color";
import { type ReportTheme, type VisualStyle, effectiveOpacity, presetFor, readTheme, readableInk } from "../theme/reportTheme";

export interface ExportTheme {
  mode: "light" | "dark";
  page: string;
  text: string;
  muted: string;
  grid: string;
  accent: string;
  accentFg: string;
  border: string;
  positive: string;
  negative: string;
  series: string[];
  /** Fond, bordure et rayon des visuels par défaut (thème du rapport). */
  visual: ReportTheme["visual"];
}

const STATUS = {
  light: { positive: "#0b7a0b", negative: "#d03b3b" },
  dark: { positive: "#34c78a", negative: "#f06a6a" },
} as const;

/** Thème du rapport, ou thème clair / sombre de l'application quand le rapport le suit. */
export function resolveReportTheme(raw: Record<string, unknown> | undefined, appMode: "light" | "dark"): ReportTheme {
  return readTheme(raw) ?? (presetFor(appMode) as ReportTheme);
}

/** Couleurs hexadécimales de l'export à partir d'un thème de rapport. */
export function exportTheme(t: ReportTheme): ExportTheme {
  const surface = blend(t.visual.background, t.page, t.visual.backgroundOpacity / 100);
  return {
    mode: t.mode === "dark" ? "dark" : "light",
    page: t.page,
    text: t.text,
    muted: t.muted,
    grid: t.grid,
    accent: t.accent,
    accentFg: isDarkColor(t.accent) ? "#ffffff" : "#0b0b0b",
    border: blend(t.text, surface, 0.14),
    ...STATUS[t.mode === "dark" ? "dark" : "light"],
    series: t.palette.slice(0, 8),
    visual: t.visual,
  };
}

/** Couleurs résolues d'un visuel (cadre, encre, séries). */
export interface VisualColors {
  /** Fond du cadre ; `transparency` = 0 (opaque) à 100 (invisible). */
  fill: { color: string; transparency: number } | null;
  border: { color: string; width: number } | null;
  radius: number;
  shadow: boolean;
  /** Fond réellement visible derrière les données (pour choisir les contours). */
  surface: string;
  fg: string;
  muted: string;
  grid: string;
  series: string[];
  title: { show: boolean; color: string; size: number; align: "left" | "center" | "right"; bold: boolean };
}

export function visualColors(theme: ExportTheme, style: VisualStyle | undefined, bare = false): VisualColors {
  const s = style ?? {};
  const series = theme.series.map((c, i) => (isHex(s.palette?.[i]) ? normalizeHex(s.palette[i] as string) : c));

  const custom = isHex(s.background);
  const bgColor = custom ? normalizeHex(s.background as string) : theme.visual.background;
  let opacity = effectiveOpacity(s, theme.visual.backgroundOpacity) / 100;
  // Opacité choisie sans couleur : elle s'applique au fond du thème (déjà éventuellement translucide).
  if (!custom && typeof s.backgroundOpacity === "number") opacity = (theme.visual.backgroundOpacity / 100) * opacity;
  const surface = blend(bgColor, theme.page, opacity);

  let border: VisualColors["border"] = null;
  if (s.border === false) border = null;
  else if (s.border === true || isHex(s.borderColor) || typeof s.borderWidth === "number") {
    const width = s.borderWidth ?? 1;
    border = width > 0 ? { color: isHex(s.borderColor) ? normalizeHex(s.borderColor) : theme.border, width } : null;
  } else if (theme.visual.border && theme.visual.borderWidth > 0) {
    border = { color: theme.visual.borderColor, width: theme.visual.borderWidth };
  }

  let fg = theme.text;
  let muted = theme.muted;
  let grid = theme.grid;
  if (custom && opacity >= 0.5) {
    fg = isHex(s.textColor) ? normalizeHex(s.textColor) : readableInk(bgColor);
    muted = blend(fg, bgColor, 0.62);
    grid = blend(fg, bgColor, 0.14);
  } else if (isHex(s.textColor)) {
    fg = normalizeHex(s.textColor);
  }

  return {
    fill: bare || opacity <= 0.001 ? null : { color: bgColor, transparency: Math.round((1 - opacity) * 100) },
    border: bare ? null : border,
    radius: s.radius ?? theme.visual.radius,
    shadow: !bare && (s.shadow ?? theme.visual.shadow) !== "none",
    surface,
    fg,
    muted,
    grid,
    series,
    title: {
      show: s.showTitle !== false,
      color: isHex(s.titleColor) ? normalizeHex(s.titleColor) : fg,
      size: s.titleSize ?? 13,
      align: s.titleAlign ?? "left",
      bold: s.titleBold === true,
    },
  };
}

/** Résout une couleur CSS des visuels (`var(--series-3)`, `var(--muted)`, hex) en hex. */
export function resolveColor(css: string, colors: VisualColors): string {
  const series = /^var\(--series-(\d)\)$/.exec(css);
  if (series) return colors.series[Number(series[1]) - 1] ?? colors.series[0] ?? "#888888";
  if (css === "var(--muted)") return colors.muted;
  if (css === "var(--fg)") return colors.fg;
  if (isHex(css)) return normalizeHex(css);
  return colors.muted;
}

/** Hex sans « # », en majuscules (format attendu par pptxgenjs ; un « # » corrompt le fichier). */
export const pptColor = (hex: string): string => normalizeHex(hex).slice(1).toUpperCase();
