/**
 * Géométrie de l'export : grille du canvas (px) → diapositive 16:9 (pouces).
 *
 * Les positions en px reproduisent exactement celles de react-grid-layout pour une page de
 * référence de `REF_WIDTH` px : un rapport exporté a donc les mêmes proportions qu'à l'écran.
 * Une page trop haute pour une diapositive est soit réduite, soit répartie sur plusieurs
 * diapositives, en coupant uniquement entre deux rangées de visuels (jamais au milieu d'un visuel).
 */

import { GRID_COLS, GRID_MARGIN, GRID_PADDING, ROW_HEIGHT } from "../studio/grid";
import type { Layout, Visual } from "../types/report";

/** Largeur de page de référence (px), proche du canvas du Studio sur un écran courant. */
export const REF_WIDTH = 1280;

/** Diapositive « grand écran » 16:9 (LAYOUT_WIDE de PowerPoint), en pouces. */
export const SLIDE = { w: 13.333, h: 7.5 } as const;
export const SLIDE_MARGIN = 0.3;
export const TITLE_BAND = 0.62;
export const FOOTER_BAND = 0.3;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Rectangle d'un visuel en px (mêmes calculs que react-grid-layout). */
export function gridRect(l: Layout, width = REF_WIDTH): Rect {
  const colW = (width - 2 * GRID_PADDING - (GRID_COLS - 1) * GRID_MARGIN) / GRID_COLS;
  return {
    x: GRID_PADDING + l.x * (colW + GRID_MARGIN),
    y: GRID_PADDING + l.y * (ROW_HEIGHT + GRID_MARGIN),
    w: l.w * colW + Math.max(0, l.w - 1) * GRID_MARGIN,
    h: l.h * ROW_HEIGHT + Math.max(0, l.h - 1) * GRID_MARGIN,
  };
}

/** Zone utile d'une diapositive de page (sous le titre éventuel, au-dessus du pied). */
export function contentArea(withTitle: boolean): Rect {
  const y = withTitle ? SLIDE_MARGIN + TITLE_BAND : SLIDE_MARGIN;
  return { x: SLIDE_MARGIN, y, w: SLIDE.w - 2 * SLIDE_MARGIN, h: SLIDE.h - y - FOOTER_BAND };
}

export interface Band {
  visuals: Visual[];
  /** Haut et bas de la bande, en px de page. */
  top: number;
  bottom: number;
}

export type FitMode = "fit" | "split";

/**
 * Découpe une page en bandes tenant chacune sur une diapositive.
 *
 * - les visuels qui se chevauchent verticalement forment un bloc insécable ;
 * - `fit` : une seule bande (la page est réduite si besoin) ;
 * - `split` : une page à peine trop haute (≤ `tolerance` × capacité) reste sur une diapositive,
 *   légèrement réduite ; sinon on remplit chaque diapositive bloc par bloc, en acceptant une
 *   réduction jusqu'à `slack` × capacité pour éviter une dernière diapositive presque vide.
 */
export function splitPage(visuals: Visual[], area: Rect, mode: FitMode, tolerance = 1.3, slack = 1.2): Band[] {
  if (!visuals.length) return [];
  const items = visuals
    .map((v) => ({ v, r: gridRect(v.layout) }))
    .sort((a, b) => a.r.y - b.r.y || a.r.x - b.r.x);
  const all: Band = {
    visuals: items.map((i) => i.v),
    top: Math.min(...items.map((i) => i.r.y)),
    bottom: Math.max(...items.map((i) => i.r.y + i.r.h)),
  };
  // Capacité d'une diapositive en px de page, à l'échelle « pleine largeur ».
  const capacity = area.h / (area.w / REF_WIDTH);
  if (mode === "fit" || all.bottom - all.top <= capacity * tolerance) return [all];

  const blocks: Band[] = [];
  for (const { v, r } of items) {
    const last = blocks[blocks.length - 1];
    if (last && r.y < last.bottom) {
      last.visuals.push(v);
      last.bottom = Math.max(last.bottom, r.y + r.h);
    } else {
      blocks.push({ visuals: [v], top: r.y, bottom: r.y + r.h });
    }
  }

  const bands: Band[] = [];
  for (const block of blocks) {
    const current = bands[bands.length - 1];
    if (current && block.bottom - current.top <= capacity * slack) {
      current.visuals.push(...block.visuals);
      current.bottom = block.bottom;
    } else {
      bands.push({ visuals: [...block.visuals], top: block.top, bottom: block.bottom });
    }
  }
  return bands;
}

export interface Placement {
  /** Pouces par px de page. */
  scale: number;
  /** Rectangle d'un visuel sur la diapositive (pouces). */
  rect: (layout: Layout) => Rect;
}

/** Met une bande à l'échelle de la zone utile : pleine largeur si possible, centrée sinon. */
export function placeBand(band: Band, area: Rect): Placement {
  const height = band.bottom - band.top + GRID_PADDING;
  const scale = Math.min(area.w / REF_WIDTH, area.h / height);
  const offsetX = area.x + (area.w - REF_WIDTH * scale) / 2;
  return {
    scale,
    rect: (layout) => {
      const r = gridRect(layout);
      return { x: offsetX + r.x * scale, y: area.y + (r.y - band.top) * scale, w: r.w * scale, h: r.h * scale };
    },
  };
}

/** Taille de police en points pour une taille écran en px, bornée pour rester lisible. */
export function fontPt(px: number, scale: number, min = 7, max = 72): number {
  const pt = px * scale * 72;
  return Math.round(Math.min(max, Math.max(min, pt)) * 2) / 2;
}

/** Rectangle intérieur (retrait en pouces sur chaque côté). */
export function inset(r: Rect, top: number, right = top, bottom = top, left = right): Rect {
  return { x: r.x + left, y: r.y + top, w: Math.max(0.05, r.w - left - right), h: Math.max(0.05, r.h - top - bottom) };
}
