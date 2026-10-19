/**
 * Géométrie des pages.
 *
 * Placement libre (au pixel près, comme Power BI) : une page a une taille en pixels (`page.size`,
 * 1280 × 720 par défaut) et chaque visuel une position `layout` en pixels de page.
 * Les anciens rapports étaient placés sur une grille de 24 colonnes : `migratePage` les convertit
 * en pixels à l'ouverture (mêmes positions qu'avant, à 1 px près).
 */

import type { Layout, Page, PageSize } from "../types/report";

// Ancienne grille (rapports d'avant le placement libre).
export const GRID_COLS = 24;
export const ROW_HEIGHT = 16;
export const GRID_MARGIN = 8;
export const GRID_PADDING = 4;
/** Largeur de référence de l'ancienne grille, et largeur par défaut d'une page. */
export const LEGACY_WIDTH = 1280;

export const DEFAULT_PAGE: PageSize = { width: 1280, height: 720 };
/** Pas de déplacement et d'espacement par défaut (px). */
export const GAP = 16;
export const MIN_W = 40;
export const MIN_H = 30;

export const PAGE_PRESETS: { id: string; label: string; size: PageSize }[] = [
  { id: "16:9", label: "16:9 (1280 × 720)", size: { width: 1280, height: 720 } },
  { id: "4:3", label: "4:3 (960 × 720)", size: { width: 960, height: 720 } },
  { id: "long", label: "Longue (1280 × 1440)", size: { width: 1280, height: 1440 } },
  { id: "a4", label: "A4 paysage (1123 × 794)", size: { width: 1123, height: 794 } },
];

/** Rectangle en px d'une position de l'ancienne grille (mêmes calculs que react-grid-layout). */
export function gridRect(l: Layout, width = LEGACY_WIDTH): Layout {
  const colW = (width - 2 * GRID_PADDING - (GRID_COLS - 1) * GRID_MARGIN) / GRID_COLS;
  return {
    x: GRID_PADDING + l.x * (colW + GRID_MARGIN),
    y: GRID_PADDING + l.y * (ROW_HEIGHT + GRID_MARGIN),
    w: l.w * colW + Math.max(0, l.w - 1) * GRID_MARGIN,
    h: l.h * ROW_HEIGHT + Math.max(0, l.h - 1) * GRID_MARGIN,
  };
}

const round = (l: Layout): Layout => ({ x: Math.round(l.x), y: Math.round(l.y), w: Math.round(l.w), h: Math.round(l.h) });

/** Taille par défaut d'un type de visuel en px (définie en cases de grille dans le registre). */
export function sizePx(size: { w: number; h: number }): { w: number; h: number } {
  const r = round(gridRect({ x: 0, y: 0, ...size }));
  return { w: r.w, h: r.h };
}

/** Bas du contenu d'une page (px). */
export function contentBottom(page: Page): number {
  return page.visuals.reduce((m, v) => Math.max(m, v.layout.y + v.layout.h), 0);
}

/** Hauteur de page suffisante pour son contenu (jamais réduite). */
export function fitHeight(page: Page): number {
  const size = page.size ?? DEFAULT_PAGE;
  return Math.max(size.height, Math.ceil((contentBottom(page) + GAP) / 8) * 8);
}

/** Convertit une page de l'ancienne grille en placement libre. Sans effet si elle l'est déjà. */
export function migratePage(page: Page): Page {
  if (page.size) return page;
  const visuals = page.visuals.map((v) => ({ ...v, layout: round(gridRect(v.layout)) }));
  const migrated: Page = { ...page, visuals, size: { ...DEFAULT_PAGE } };
  return { ...migrated, size: { width: DEFAULT_PAGE.width, height: fitHeight(migrated) } };
}

/** Garde un rectangle dans la largeur de la page (la hauteur s'agrandit au besoin). */
export function clampToPage(l: Layout, size: PageSize): Layout {
  const w = Math.max(MIN_W, Math.min(Math.round(l.w), size.width));
  const h = Math.max(MIN_H, Math.round(l.h));
  return { x: Math.max(0, Math.min(Math.round(l.x), size.width - w)), y: Math.max(0, Math.round(l.y)), w, h };
}
