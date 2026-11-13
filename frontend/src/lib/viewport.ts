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

/** Épaisseur mesurée, et le zoom du navigateur auquel elle l'a été (elle change avec lui, en px de la page). */
let classicScrollbar: { size: number; ratio: number } | null = null;

/**
 * Épaisseur d'une barre de défilement de ce navigateur, en px : 15 à 17 sous Windows, 0 quand les barres se
 * superposent au contenu (macOS, téléphone) ou hors navigateur. Mesurée sur un élément jetable, une fois par
 * niveau de zoom du navigateur.
 */
export function scrollbarSize(): number {
  if (typeof document === "undefined" || !document.body) return 0;
  const ratio = window.devicePixelRatio || 1;
  if (classicScrollbar?.ratio === ratio) return classicScrollbar.size;
  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;top:-9999px;left:-9999px;width:100px;height:100px;overflow:scroll;visibility:hidden";
  document.body.appendChild(probe);
  classicScrollbar = { size: Math.max(0, probe.offsetWidth - probe.clientWidth), ratio };
  probe.remove();
  return classicScrollbar.size;
}

/** Oublie l'épaisseur mesurée (tests). */
export function forgetScrollbarSize(): void {
  classicScrollbar = null;
}
