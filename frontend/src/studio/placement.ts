/** Placement automatique de nouveaux visuels sous le contenu existant (grille de 24 colonnes). */

import type { Layout, Page, VisualType } from "../types/report";
import { VISUALS } from "../visuals/registry";
import { GRID_COLS as GRID_WIDTH } from "./grid";

/**
 * Range les visuels en rangées, de gauche à droite, sous le visuel le plus bas de la page.
 * Une rangée qui n'a plus la place passe à la ligne ; sa hauteur est celle de son plus haut visuel.
 */
export function placeVisuals(page: Page, types: VisualType[]): Layout[] {
  let y = page.visuals.reduce((m, v) => Math.max(m, v.layout.y + v.layout.h), 0);
  let x = 0;
  let rowHeight = 0;
  return types.map((type) => {
    const { w, h } = VISUALS[type].size;
    const width = Math.min(w, GRID_WIDTH);
    if (x + width > GRID_WIDTH) {
      y += rowHeight;
      x = 0;
      rowHeight = 0;
    }
    const layout = { x, y, w: width, h };
    x += width;
    rowHeight = Math.max(rowHeight, h);
    return layout;
  });
}
