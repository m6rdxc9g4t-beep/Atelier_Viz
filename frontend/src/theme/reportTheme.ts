/**
 * Thèmes de rapport et styles de visuels.
 *
 * Tout passe par des variables CSS posées sur la racine du rapport (et sur chaque visuel pour
 * ses surcharges) : les graphiques utilisent déjà var(--series-n), var(--fg), var(--grid)…,
 * donc changer un hexadécimal recolore tout sans toucher aux composants.
 *
 * Les palettes des préréglages sont la palette de référence validée (daltonisme, contraste),
 * vérifiée sur chaque fond avec le validateur du guide dataviz.
 */

import type { CSSProperties } from "react";

import { blend, contrast, isDarkColor, isHex, normalizeHex, rgba } from "./color";

export type Shadow = "none" | "soft" | "strong";
export type Mode = "auto" | "light" | "dark";

/** Style d'un visuel. Champs absents = valeur du thème du rapport. */
export interface VisualStyle {
  background?: string;
  /** 0 = transparent, 100 = opaque. */
  backgroundOpacity?: number;
  border?: boolean;
  borderColor?: string;
  borderWidth?: number;
  radius?: number;
  shadow?: Shadow;
  padding?: number;
  showTitle?: boolean;
  titleColor?: string;
  titleSize?: number;
  titleAlign?: "left" | "center" | "right";
  titleBold?: boolean;
  textColor?: string;
  /** Couleurs des données propres au visuel (8 max). */
  palette?: string[];
}

export interface ReportTheme {
  mode: Mode;
  preset: string;
  wallpaper: string;
  page: string;
  text: string;
  muted: string;
  grid: string;
  accent: string;
  palette: string[];
  visual: Required<Pick<VisualStyle, "background" | "backgroundOpacity" | "border" | "borderColor" | "borderWidth" | "radius" | "shadow">>;
}

export const LIGHT_PALETTE = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
export const DARK_PALETTE = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];

type ThemeOverrides = Partial<Omit<ReportTheme, "visual">> & { visual?: Partial<ReportTheme["visual"]> };

const light = (over: ThemeOverrides): ReportTheme => ({
  mode: "light",
  preset: "light",
  wallpaper: "#e9e8e4",
  page: "#f4f4f2",
  text: "#0b0b0b",
  muted: "#62615c",
  grid: "#e3e2de",
  accent: "#2a78d6",
  palette: LIGHT_PALETTE,
  ...over,
  visual: { background: "#fcfcfb", backgroundOpacity: 100, border: true, borderColor: "#e3e2de", borderWidth: 1, radius: 8, shadow: "none", ...over.visual },
});

const dark = (over: ThemeOverrides): ReportTheme => ({
  mode: "dark",
  preset: "dark",
  wallpaper: "#0a0a09",
  page: "#0f0f0e",
  text: "#f0efec",
  muted: "#a6a59c",
  grid: "#2c2c29",
  accent: "#3987e5",
  palette: DARK_PALETTE,
  ...over,
  visual: { background: "#1a1a19", backgroundOpacity: 100, border: true, borderColor: "#33332f", borderWidth: 1, radius: 8, shadow: "none", ...over.visual },
});

export interface Preset {
  id: string;
  label: string;
  description: string;
  theme: ReportTheme;
}

export const PRESETS: Preset[] = [
  { id: "light", label: "Standard", description: "Clair et sobre", theme: light({}) },
  {
    id: "glass",
    label: "Verre",
    description: "Visuels transparents, bords fins",
    theme: light({
      preset: "glass",
      wallpaper: "#dfe6ee",
      page: "#eef2f6",
      text: "#0f172a",
      muted: "#526075",
      grid: "#d5dde7",
      visual: { background: "#ffffff", backgroundOpacity: 0, borderColor: "#c7d2df", radius: 12 },
    }),
  },
  {
    id: "paper",
    label: "Papier",
    description: "Blanc, sans bordure, ombre douce",
    theme: light({
      preset: "paper",
      wallpaper: "#e7e7e7",
      page: "#ffffff",
      text: "#111111",
      muted: "#5b5b5b",
      grid: "#ececec",
      visual: { background: "#ffffff", border: false, radius: 10, shadow: "soft" },
    }),
  },
  {
    id: "contrast",
    label: "Contraste élevé",
    description: "Bordures nettes, texte noir",
    theme: light({
      preset: "contrast",
      wallpaper: "#ffffff",
      page: "#ffffff",
      text: "#000000",
      muted: "#333333",
      grid: "#bdbdbd",
      accent: "#1c5cab",
      visual: { background: "#ffffff", borderColor: "#0b0b0b", borderWidth: 2, radius: 4 },
    }),
  },
  { id: "dark", label: "Standard", description: "Sombre et sobre", theme: dark({}) },
  {
    id: "midnight",
    label: "Minuit",
    description: "Bleu nuit, ombre légère",
    theme: dark({
      preset: "midnight",
      wallpaper: "#070c18",
      page: "#0b1220",
      text: "#e6edf7",
      muted: "#93a1b8",
      grid: "#1c2740",
      visual: { background: "#111a2e", borderColor: "#1f2a44", radius: 10, shadow: "soft" },
    }),
  },
  {
    id: "glass-dark",
    label: "Verre",
    description: "Visuels transparents sur fond sombre",
    theme: dark({
      preset: "glass-dark",
      wallpaper: "#060912",
      page: "#0b1020",
      text: "#e6edf7",
      muted: "#93a1b8",
      grid: "#1d2740",
      visual: { background: "#0b1020", backgroundOpacity: 0, borderColor: "#26314d", radius: 12 },
    }),
  },
];

export const presetFor = (id: string): ReportTheme | undefined => PRESETS.find((p) => p.id === id)?.theme;

/** Lit `report.theme` (JSON libre) ; vide ou invalide = suivre l'application. */
export function readTheme(raw: Record<string, unknown> | undefined): ReportTheme | null {
  if (!raw || raw.mode === undefined || raw.mode === "auto") return null;
  const base = (raw.mode === "dark" ? presetFor("dark") : presetFor("light")) as ReportTheme;
  const v = (raw.visual ?? {}) as Partial<ReportTheme["visual"]>;
  const hex = (x: unknown, fallback: string) => (isHex(x) ? normalizeHex(x) : fallback);
  const palette = Array.isArray(raw.palette) ? raw.palette.filter(isHex).map(normalizeHex) : [];
  return {
    mode: raw.mode === "dark" ? "dark" : "light",
    preset: typeof raw.preset === "string" ? raw.preset : "custom",
    wallpaper: hex(raw.wallpaper, base.wallpaper),
    page: hex(raw.page, base.page),
    text: hex(raw.text, base.text),
    muted: hex(raw.muted, base.muted),
    grid: hex(raw.grid, base.grid),
    accent: hex(raw.accent, base.accent),
    palette: palette.length ? [...palette, ...base.palette].slice(0, 8) : base.palette,
    visual: {
      background: hex(v.background, base.visual.background),
      backgroundOpacity: num(v.backgroundOpacity, base.visual.backgroundOpacity, 0, 100),
      border: typeof v.border === "boolean" ? v.border : base.visual.border,
      borderColor: hex(v.borderColor, base.visual.borderColor),
      borderWidth: num(v.borderWidth, base.visual.borderWidth, 0, 8),
      radius: num(v.radius, base.visual.radius, 0, 32),
      shadow: v.shadow === "soft" || v.shadow === "strong" || v.shadow === "none" ? v.shadow : base.visual.shadow,
    },
  };
}

function num(x: unknown, fallback: number, min: number, max: number): number {
  return typeof x === "number" && Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : fallback;
}

const SHADOWS: Record<Shadow, string> = {
  none: "none",
  soft: "0 1px 2px rgba(0,0,0,.06), 0 4px 12px rgba(0,0,0,.06)",
  strong: "0 2px 4px rgba(0,0,0,.10), 0 12px 28px rgba(0,0,0,.14)",
};

type CssVars = CSSProperties & Record<`--${string}`, string>;

/** Variables CSS du rapport (posées sur la racine du canvas). */
export function themeVars(t: ReportTheme): CssVars {
  const surface = blend(t.visual.background, t.page, t.visual.backgroundOpacity / 100);
  const vars: CssVars = {
    "--canvas": t.wallpaper,
    "--bg": t.page,
    "--page-bg": t.page,
    "--surface": surface,
    "--surface-2": blend(t.text, surface, 0.06),
    "--border": blend(t.text, surface, 0.14),
    "--fg": t.text,
    "--muted": t.muted,
    "--grid": t.grid,
    "--accent": t.accent,
    "--accent-fg": isDarkColor(t.accent) ? "#ffffff" : "#0b0b0b",
    "--visual-bg": rgba(t.visual.background, t.visual.backgroundOpacity / 100),
    "--visual-border": t.visual.border && t.visual.borderWidth > 0 ? `${t.visual.borderWidth}px solid ${t.visual.borderColor}` : "1px solid transparent",
    "--visual-radius": `${t.visual.radius}px`,
    "--visual-shadow": SHADOWS[t.visual.shadow],
  };
  t.palette.slice(0, 8).forEach((c, i) => (vars[`--series-${i + 1}`] = c));
  return vars;
}

/** Styles inline d'un visuel (surcharges du thème). */
export function visualCss(style: VisualStyle | undefined, pageColor: string | null): CssVars {
  const css: CssVars = {};
  if (!style) return css;
  if (isHex(style.background) || typeof style.backgroundOpacity === "number") {
    const opacity = (style.backgroundOpacity ?? 100) / 100;
    if (isHex(style.background)) {
      css.background = rgba(style.background, opacity);
      // Surface pleine (info-bulles, séparateurs) : fond du visuel posé sur la page.
      if (opacity >= 0.999) css["--surface"] = normalizeHex(style.background);
      else if (pageColor) css["--surface"] = blend(style.background, pageColor, opacity);
    } else if (opacity < 0.999) {
      css.background = `color-mix(in srgb, var(--visual-bg) ${Math.round(opacity * 100)}%, transparent)`;
    }
  }
  if (style.border === false) css.border = "1px solid transparent";
  else if (style.border === true || isHex(style.borderColor) || typeof style.borderWidth === "number") {
    const width = style.borderWidth ?? 1;
    css.border = width > 0 ? `${width}px solid ${isHex(style.borderColor) ? style.borderColor : "var(--border)"}` : "1px solid transparent";
  }
  // Fond choisi (au moins à moitié opaque) : encre, axes et quadrillage s'accordent à ce fond,
  // même si le thème du rapport est d'une autre luminosité (visuel sombre dans un rapport clair).
  const opacity = (style.backgroundOpacity ?? 100) / 100;
  if (isHex(style.background) && opacity >= 0.5) {
    const bg = normalizeHex(style.background);
    const fg = isHex(style.textColor) ? normalizeHex(style.textColor) : readableInk(bg);
    css["--fg"] = fg;
    css["--muted"] = blend(fg, bg, 0.62);
    css["--grid"] = blend(fg, bg, 0.14);
    css["--surface-2"] = blend(fg, bg, 0.07);
  }
  if (typeof style.radius === "number") css.borderRadius = `${style.radius}px`;
  if (style.shadow) css.boxShadow = SHADOWS[style.shadow];
  if (typeof style.padding === "number") css.padding = `${style.padding}px`;
  if (isHex(style.textColor)) css["--fg"] = style.textColor;
  style.palette?.forEach((c, i) => {
    if (isHex(c) && i < 8) css[`--series-${i + 1}`] = c;
  });
  return css;
}

export function titleCss(style: VisualStyle | undefined): CSSProperties {
  return {
    color: isHex(style?.titleColor) ? style?.titleColor : undefined,
    fontSize: style?.titleSize ? `${style.titleSize}px` : undefined,
    textAlign: style?.titleAlign,
    fontWeight: style?.titleBold ? 600 : undefined,
  };
}

/** Encre (quasi noire ou quasi blanche) la plus lisible sur un fond. */
export function readableInk(bg: string): string {
  return contrast(bg, "#0b0b0b") >= contrast(bg, "#f0efec") ? "#0b0b0b" : "#f0efec";
}

/** Opacité effective du fond d'un visuel : choisir une couleur implique un fond opaque. */
export function effectiveOpacity(style: VisualStyle | undefined, inherited: number | undefined): number {
  return style?.backgroundOpacity ?? (isHex(style?.background) ? 100 : (inherited ?? 100));
}

/** Avertissement de contraste (seuil 3:1 pour les marques, 4,5:1 pour le texte). */
export function contrastWarning(color: string, against: string, min: number): string | null {
  if (!isHex(color) || !isHex(against)) return null;
  const ratio = contrast(color, against);
  return ratio < min ? `Contraste ${ratio.toFixed(1).replace(".", ",")}:1 (min. ${String(min).replace(".", ",")}:1)` : null;
}

/**
 * Import d'un fichier de thème : format Atelier Viz, ou thème Power BI
 * (dataColors, background, foreground, tableAccent).
 */
export function importTheme(json: unknown): ReportTheme {
  if (!json || typeof json !== "object") throw new Error("Fichier de thème invalide.");
  const o = json as Record<string, unknown>;
  if (o.mode === "light" || o.mode === "dark") {
    const t = readTheme(o);
    if (t) return t;
  }
  if (Array.isArray(o.dataColors)) {
    const page = isHex(o.background) ? normalizeHex(o.background) : "#ffffff";
    const mode = isDarkColor(page) ? "dark" : "light";
    const base = presetFor(mode) as ReportTheme;
    return readTheme({
      ...base,
      preset: "custom",
      mode,
      page,
      text: isHex(o.foreground) ? o.foreground : base.text,
      accent: isHex(o.tableAccent) ? o.tableAccent : base.accent,
      palette: o.dataColors,
      visual: { ...base.visual, background: page },
    }) as ReportTheme;
  }
  throw new Error("Format non reconnu : thème Atelier Viz ou thème Power BI (dataColors) attendu.");
}
