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

/** Largeur de la barre d'actions la plus fournie (poignée, alerte, export, plans, dupliquer, supprimer) et son retrait du bord droit. */
export const TOOLBAR_WIDTH = 152;
export const TOOLBAR_INSET = 8;

export type ToolbarSide = "above" | "below" | "inside";

/** Zone de la page que couvre la barre d'actions : alignée à droite du visuel, hors de son cadre (ou dans son haut). */
export function toolbarZone(layout: Layout, side: ToolbarSide): Layout {
  const y = side === "above" ? layout.y - TOOLBAR_HEIGHT : side === "below" ? layout.y + layout.h : layout.y;
  return { x: layout.x + layout.w - TOOLBAR_INSET - TOOLBAR_WIDTH, y, w: TOOLBAR_WIDTH, h: TOOLBAR_HEIGHT };
}

const overlaps = (a: Layout, b: Layout) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Où poser la barre d'actions d'un visuel en édition : hors du cadre pour ne recouvrir ni son titre ni son
 * contenu — au-dessus s'il y a la place dans la page, sinon dessous, et dans le cadre en dernier recours
 * (visuel qui occupe toute la hauteur de la page).
 *
 * `controls` : les autres visuels cliquables de la page (navigateur, boutons). La barre d'un visuel sélectionné
 * reste affichée : posée sur un onglet du navigateur, elle le rendait illisible et incliquable. Elle passe donc
 * de l'autre côté quand celui-ci est libre ; si les deux côtés en recouvrent un, elle garde le premier.
 */
export function toolbarSide(layout: Layout, page: { width: number; height: number }, controls: readonly Layout[] = []): ToolbarSide {
  const sides: ToolbarSide[] = [];
  if (layout.y >= TOOLBAR_HEIGHT) sides.push("above");
  if (layout.y + layout.h + TOOLBAR_HEIGHT <= page.height) sides.push("below");
  const free = sides.find((side) => !controls.some((c) => overlaps(toolbarZone(layout, side), c)));
  return free ?? sides[0] ?? "inside";
}
