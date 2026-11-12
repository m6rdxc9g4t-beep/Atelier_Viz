import { useEffect, useState } from "react";

/** Écran étroit (téléphone) : sous le palier `md` de Tailwind, là où les volets du Studio ne tiennent plus à côté de la page. */
export const NARROW_QUERY = "(max-width: 767px)";

/** Vrai sur un écran étroit au moment de l'appel (faux quand `matchMedia` n'existe pas : tests, rendu hors navigateur). */
export function isNarrowScreen(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(NARROW_QUERY).matches;
}

/** Suit l'écran étroit pendant la vie du composant (fenêtre redimensionnée, téléphone tourné). */
export function useNarrowScreen(): boolean {
  const [narrow, setNarrow] = useState(isNarrowScreen);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(NARROW_QUERY);
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  return narrow;
}
