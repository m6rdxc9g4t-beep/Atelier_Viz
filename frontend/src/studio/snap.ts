/**
 * Géométrie du placement libre : déplacement, redimensionnement et repères d'alignement
 * (« repères intelligents » de Power BI) sur les bords et centres des autres visuels et de la page.
 * Fonctions pures, en pixels de page.
 */

import type { Layout, PageSize } from "../types/report";
import { MIN_H, MIN_W } from "./grid";

/** Poignée de redimensionnement : combinaison de n (haut), s (bas), e (droite), w (gauche). */
export type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
export const RESIZE_DIRS: ResizeDir[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** Repères affichés pendant un déplacement : abscisses verticales et ordonnées horizontales. */
export interface Guides {
  x: number[];
  y: number[];
}

export interface Snapped {
  rect: Layout;
  guides: Guides;
}

/** Lignes d'accroche d'un axe : bords et centres des autres visuels, bords, marges et centre de la page. */
function lines(others: Layout[], size: PageSize, axis: "x" | "y", margin: number): number[] {
  const extent = axis === "x" ? size.width : size.height;
  const out = [0, margin, extent / 2, extent - margin, extent];
  for (const o of others) {
    const start = axis === "x" ? o.x : o.y;
    const len = axis === "x" ? o.w : o.h;
    out.push(start, start + len / 2, start + len);
  }
  return out;
}

/** Meilleure accroche : écart à appliquer (ou null) pour amener un des `points` sur une ligne, à `threshold` près. */
function nearest(points: number[], targets: number[], threshold: number): { delta: number; at: number[] } | null {
  let best: { delta: number; at: number[] } | null = null;
  for (const p of points) {
    for (const t of targets) {
      const d = t - p;
      if (Math.abs(d) > threshold) continue;
      if (!best || Math.abs(d) < Math.abs(best.delta) - 1e-9) best = { delta: d, at: [t] };
    }
  }
  if (!best) return null;
  // Toutes les lignes atteintes une fois l'écart appliqué (ex. bord gauche et centre alignés en même temps).
  const delta = best.delta;
  const at = [...new Set(targets.filter((t) => points.some((p) => Math.abs(p + delta - t) < 0.5)))];
  return { delta, at };
}

/**
 * Déplace `orig` de (dx, dy), puis l'accroche aux lignes voisines quand `snap` est vrai.
 * Le visuel reste dans la largeur de la page ; vers le bas, la page s'agrandit.
 */
export function moveRect(orig: Layout, dx: number, dy: number, others: Layout[], size: PageSize, threshold: number, snap: boolean, margin = 16): Snapped {
  let x = Math.round(orig.x + dx);
  let y = Math.round(orig.y + dy);
  const guides: Guides = { x: [], y: [] };
  if (snap) {
    const sx = nearest([x, x + orig.w / 2, x + orig.w], lines(others, size, "x", margin), threshold);
    if (sx) {
      x = Math.round(x + sx.delta);
      guides.x = sx.at;
    }
    const sy = nearest([y, y + orig.h / 2, y + orig.h], lines(others, size, "y", margin), threshold);
    if (sy) {
      y = Math.round(y + sy.delta);
      guides.y = sy.at;
    }
  }
  x = Math.max(0, Math.min(x, size.width - orig.w));
  y = Math.max(0, y);
  return { rect: { x, y, w: orig.w, h: orig.h }, guides: keepVisible(guides, { x, y, w: orig.w, h: orig.h }) };
}

/**
 * Redimensionne `orig` par la poignée `dir` de (dx, dy) ; seuls les bords tirés s'accrochent.
 * `keepRatio` (Maj) conserve les proportions sur les coins.
 */
export function resizeRect(
  orig: Layout,
  dir: ResizeDir,
  dx: number,
  dy: number,
  others: Layout[],
  size: PageSize,
  threshold: number,
  snap: boolean,
  keepRatio = false,
  margin = 16,
): Snapped {
  let left = orig.x;
  let top = orig.y;
  let right = orig.x + orig.w;
  let bottom = orig.y + orig.h;
  if (dir.includes("w")) left += dx;
  if (dir.includes("e")) right += dx;
  if (dir.includes("n")) top += dy;
  if (dir.includes("s")) bottom += dy;

  const guides: Guides = { x: [], y: [] };
  if (snap) {
    const xs = lines(others, size, "x", margin);
    const ys = lines(others, size, "y", margin);
    if (dir.includes("w") || dir.includes("e")) {
      const edge = dir.includes("w") ? left : right;
      const s = nearest([edge], xs, threshold);
      if (s) {
        if (dir.includes("w")) left += s.delta;
        else right += s.delta;
        guides.x = s.at;
      }
    }
    if (dir.includes("n") || dir.includes("s")) {
      const edge = dir.includes("n") ? top : bottom;
      const s = nearest([edge], ys, threshold);
      if (s) {
        if (dir.includes("n")) top += s.delta;
        else bottom += s.delta;
        guides.y = s.at;
      }
    }
  }

  // Tailles minimales, côté opposé fixe.
  if (right - left < MIN_W) {
    if (dir.includes("w")) left = right - MIN_W;
    else right = left + MIN_W;
  }
  if (bottom - top < MIN_H) {
    if (dir.includes("n")) top = bottom - MIN_H;
    else bottom = top + MIN_H;
  }
  // Proportions conservées (coins, Maj) : la hauteur suit la largeur.
  if (keepRatio && dir.length === 2 && orig.w > 0) {
    const h = Math.max(MIN_H, ((right - left) * orig.h) / orig.w);
    if (dir.includes("n")) top = bottom - h;
    else bottom = top + h;
    guides.y = [];
  }
  // Dans la page : bord gauche ≥ 0, bord droit ≤ largeur, haut ≥ 0.
  left = Math.max(0, left);
  top = Math.max(0, top);
  right = Math.min(size.width, Math.max(right, left + MIN_W));
  bottom = Math.max(bottom, top + MIN_H);
  const rect = { x: Math.round(left), y: Math.round(top), w: Math.round(right - left), h: Math.round(bottom - top) };
  return { rect, guides: keepVisible(guides, rect) };
}

/** Garde les repères effectivement touchés par le rectangle final (après bornage dans la page). */
function keepVisible(g: Guides, r: Layout): Guides {
  const on = (v: number, a: number, len: number) => Math.abs(v - a) < 1 || Math.abs(v - (a + len / 2)) < 1 || Math.abs(v - (a + len)) < 1;
  return { x: g.x.filter((v) => on(v, r.x, r.w)), y: g.y.filter((v) => on(v, r.y, r.h)) };
}

/** Curseur CSS d'une poignée. */
export function resizeCursor(dir: ResizeDir): string {
  return dir === "n" || dir === "s" ? "ns-resize" : dir === "e" || dir === "w" ? "ew-resize" : dir === "ne" || dir === "sw" ? "nesw-resize" : "nwse-resize";
}
