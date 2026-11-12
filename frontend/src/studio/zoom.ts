/**
 * Zoom de la page dans le Studio (logique pure, sans DOM) : ajustement automatique à la place disponible,
 * paliers du contrôle de zoom, molette.
 *
 * Par défaut la page est « ajustée » : entière dans la place que laissent les barres et les volets, pour que
 * rien ne soit coupé (ni le bas d'un tableau, ni la colonne de droite). L'ajustement est recalculé à chaque
 * changement de place — volet ouvert ou replié, fenêtre redimensionnée — tant que l'utilisateur n'a pas choisi
 * un zoom à la main ; « Ajuster » y revient.
 */

export interface Size {
  width: number;
  height: number;
}

/** Choix de l'utilisateur : ajusté à la page (défaut), à la largeur, ou un zoom fixe. */
export type ZoomChoice = "fit" | "width" | number;

/** Emplacement du contrôle de zoom dans la barre des pages (`PageTabs`) : il n'y recouvre jamais la page. */
export const ZOOM_SLOT_ID = "studio-zoom";

/** Paliers des boutons − et +. */
export const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 2;
/** Échelle minimale d'un ajustement (une page de 1280 px tient dans un écran de 250 px). */
export const FIT_MIN = 0.15;
/**
 * Page longue (elle s'allonge quand un visuel dépasse le bas) : si la montrer entière la réduisait à moins de
 * la moitié de sa taille ajustée à la largeur, elle reste à la largeur et se lit en défilant.
 */
export const TALL_PAGE_RATIO = 0.5;

/** Borné, et arrondi au millième par défaut : la page ajustée ne dépasse jamais la place d'une fraction de pixel. */
const clamp = (z: number) => Math.min(ZOOM_MAX, Math.max(FIT_MIN, Math.floor(z * 1000) / 1000));

/** Zoom qui fait tenir la largeur de la page dans la place (`area` : place utile, marges déjà retirées). */
export function widthZoom(page: Size, area: Size): number {
  if (area.width <= 0 || page.width <= 0) return 1;
  return clamp(area.width / page.width);
}

/**
 * Zoom « ajusté » : la page entière dans la place, en largeur comme en hauteur. Une page beaucoup plus haute
 * que la place (`TALL_PAGE_RATIO`) est ajustée à la largeur seulement.
 */
export function fitZoom(page: Size, area: Size): number {
  const byWidth = widthZoom(page, area);
  if (area.height <= 0 || page.height <= 0) return byWidth;
  const whole = Math.min(area.width / page.width, area.height / page.height);
  return whole < byWidth * TALL_PAGE_RATIO ? byWidth : clamp(whole);
}

/** Zoom effectif d'un choix, pour une page et une place données. */
export function resolveZoom(choice: ZoomChoice, page: Size, area: Size): number {
  if (choice === "fit") return fitZoom(page, area);
  if (choice === "width") return widthZoom(page, area);
  return choice;
}

/** Palier suivant (`dir` = 1) ou précédent (−1) à partir du zoom affiché ; `null` au bout de l'échelle. */
export function stepZoom(zoom: number, dir: 1 | -1): number | null {
  const next = dir > 0 ? ZOOM_STEPS.find((z) => z > zoom + 0.001) : [...ZOOM_STEPS].reverse().find((z) => z < zoom - 0.001);
  return next ?? null;
}

/** Ctrl + molette : un cran de 10 %, borné, arrondi au centième. */
export function wheelZoom(zoom: number, deltaY: number): number {
  const z = zoom * (deltaY < 0 ? 1.1 : 1 / 1.1);
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 100) / 100));
}
