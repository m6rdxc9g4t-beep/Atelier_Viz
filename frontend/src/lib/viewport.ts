/** Écran étroit (téléphone) : sous le palier `md` de Tailwind, là où les volets du Studio ne tiennent plus à côté de la page. */
export const NARROW_QUERY = "(max-width: 767px)";

/** Vrai sur un écran étroit au moment de l'appel (faux quand `matchMedia` n'existe pas : tests, rendu hors navigateur). */
export function isNarrowScreen(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(NARROW_QUERY).matches;
}
