import type { Layout } from "../types/report";

/** Hauteur de la barre d'actions d'un visuel, écart au cadre compris (px de page). */
export const TOOLBAR_HEIGHT = 32;

export type ToolbarSide = "above" | "below" | "inside";

/**
 * Où poser la barre d'actions d'un visuel en édition : hors du cadre pour ne recouvrir ni son titre ni son
 * contenu — au-dessus s'il y a la place dans la page, sinon dessous, et dans le cadre en dernier recours
 * (visuel qui occupe toute la hauteur de la page).
 */
export function toolbarSide(layout: Layout, page: { width: number; height: number }): ToolbarSide {
  if (layout.y >= TOOLBAR_HEIGHT) return "above";
  if (layout.y + layout.h + TOOLBAR_HEIGHT <= page.height) return "below";
  return "inside";
}
