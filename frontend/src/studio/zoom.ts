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
 * Page d'un écran (paysage, jusqu'au 4:3 : 16:9, 4:3, A4 paysage, page à peine allongée) : elle se montre entière
 * tant qu'elle garde la moitié de sa taille ajustée à la largeur — même dans une fenêtre large et basse.
 */
export const SCREEN_PAGE_RATIO = 0.5;
/**
 * Page longue (« Longue », ou allongée par un visuel posé en bas) : elle se lit à la largeur, en défilant, dès que
 * la montrer entière lui ferait perdre plus du quart de cette taille (son texte deviendrait illisible).
 */
export const TALL_PAGE_RATIO = 0.75;
/** Hauteur rapportée à la largeur au-delà de laquelle une page n'a plus le format d'un écran (4:3). */
export const SCREEN_SHAPE = 0.75;

/** Borné, et arrondi au millième par défaut : la page ajustée ne dépasse jamais la place d'une fraction de pixel. */
const clamp = (z: number) => Math.min(ZOOM_MAX, Math.max(FIT_MIN, Math.floor(z * 1000) / 1000));

/**
 * Zoom qui fait tenir la largeur de la page dans la place.
 *
 * `area` est la place de la zone de défilement **barres de défilement comprises** (sa boîte, marges retirées),
 * jamais sa place « utile » du moment : celle-ci rétrécit quand une barre apparaît, et un zoom calculé d'après
 * elle ferait apparaître puis disparaître la barre sans fin (Chrome sous Windows, barres de 15 à 17 px).
 * `scrollbar` est l'épaisseur d'une barre classique (0 quand elles se superposent au contenu : macOS, téléphone) :
 * elle est retirée d'avance quand la page, à la largeur, dépasse en hauteur — la barre verticale sera là.
 */
export function widthZoom(page: Size, area: Size, scrollbar = 0): number {
  if (area.width <= 0 || page.width <= 0) return 1;
  const plain = area.width / page.width;
  const scrolls = scrollbar > 0 && area.height > 0 && page.height * plain > area.height;
  return clamp(scrolls ? Math.max(area.width - scrollbar, 1) / page.width : plain);
}

/**
 * Zoom « ajusté » : la page entière dans la place, en largeur comme en hauteur. Une page longue que cela
 * réduirait trop (`TALL_PAGE_RATIO`, `SCREEN_PAGE_RATIO` pour une page d'un écran) est ajustée à la largeur
 * seulement. Le choix ne dépend que de la page et de la boîte de la zone, jamais de l'état des barres de défilement.
 */
export function fitZoom(page: Size, area: Size, scrollbar = 0): number {
  const byWidth = widthZoom(page, area, scrollbar);
  if (area.height <= 0 || page.height <= 0) return byWidth;
  const whole = Math.min(area.width / page.width, area.height / page.height);
  const ratio = page.height > page.width * SCREEN_SHAPE ? TALL_PAGE_RATIO : SCREEN_PAGE_RATIO;
  return whole < byWidth * ratio ? byWidth : clamp(whole);
}

/** Zoom effectif d'un choix, pour une page et une place données. */
export function resolveZoom(choice: ZoomChoice, page: Size, area: Size, scrollbar = 0): number {
  if (choice === "fit") return fitZoom(page, area, scrollbar);
  if (choice === "width") return widthZoom(page, area, scrollbar);
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
