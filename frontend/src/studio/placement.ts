/** Placement automatique de nouveaux visuels sur une page en pixels (premier espace libre). */

import type { Layout, Page, VisualType } from "../types/report";
import { VISUALS } from "../visuals/registry";
import { DEFAULT_PAGE, GAP, contentBottom, sizePx } from "./grid";

const overlaps = (a: Layout, b: Layout): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Premier emplacement libre (de haut en bas, puis de gauche à droite) pour un rectangle w × h :
 * aligné sur le bord gauche ou à droite d'un visuel, en haut ou sous un visuel, avec une marge.
 * Sans place dans la hauteur de la page : sous le contenu (la page s'agrandit).
 */
export function findFreeSpot(page: Page, w: number, h: number): Layout {
  const size = page.size ?? DEFAULT_PAGE;
  const width = Math.min(w, size.width - 2 * GAP);
  const xs = [GAP, ...page.visuals.map((v) => v.layout.x + v.layout.w + GAP)];
  const ys = [GAP, ...page.visuals.map((v) => v.layout.y + v.layout.h + GAP)];
  const candidates = ys.flatMap((y) => xs.map((x) => ({ x, y, w: width, h }))).sort((a, b) => a.y - b.y || a.x - b.x);
  // Marge autour des visuels existants : deux visuels ne se touchent jamais.
  const padded = page.visuals.map((v) => ({ x: v.layout.x - GAP + 1, y: v.layout.y - GAP + 1, w: v.layout.w + 2 * GAP - 2, h: v.layout.h + 2 * GAP - 2 }));
  const fits = (r: Layout) => r.x + r.w <= size.width - GAP + 1 && r.y + r.h <= size.height && !padded.some((p) => overlaps(r, p));
  return candidates.find(fits) ?? { x: GAP, y: (page.visuals.length ? contentBottom(page) : 0) + GAP, w: width, h };
}

/** Places pour plusieurs nouveaux visuels, chacun tenant compte des précédents. */
export function placeVisuals(page: Page, types: VisualType[]): Layout[] {
  const work: Page = { ...page, visuals: [...page.visuals] };
  return types.map((type) => {
    const { w, h } = sizePx(VISUALS[type].size);
    const layout = findFreeSpot(work, w, h);
    work.visuals.push({ id: `tmp-${work.visuals.length}`, type, layout, roles: {}, options: {}, filters: [] });
    return layout;
  });
}
