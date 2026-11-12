import type { Layout } from "../types/report";

/** Hauteur de la barre d'actions d'un visuel, écart au cadre compris (px de page). */
export const TOOLBAR_HEIGHT = 32;

/** Hauteur de la poignée de déplacement d'un visuel : la bande du haut de son cadre (`h-6`). */
export const HANDLE_HEIGHT = 24;

/**
 * Plans d'empilement dans la page (classes Tailwind). La barre d'actions flotte hors du cadre de son visuel,
 * donc par-dessus un voisin : elle passe toujours devant les poignées de déplacement, sinon la poignée
 * (invisible) du visuel du dessous recevait les clics destinés à la barre d'un titre ou d'un navigateur.
 */
export const HANDLE_LAYER = "z-20";
export const TOOLBAR_LAYER = "z-30";

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

/** Zone de la page que couvre la barre d'actions (toute la largeur du visuel : elle s'aligne à droite). */
export function toolbarZone(layout: Layout, side: ToolbarSide): Layout {
  const y = side === "above" ? layout.y - TOOLBAR_HEIGHT : side === "below" ? layout.y + layout.h : layout.y;
  return { x: layout.x, y, w: layout.w, h: TOOLBAR_HEIGHT };
}
