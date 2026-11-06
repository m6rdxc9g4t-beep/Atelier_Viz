import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";

/** API posée par `styles/atelier-brand/atelier-theme.js` (copie verbatim, chargée avant l'affichage). */
interface AtelierThemeApi {
  get(): ThemePreference;
  set(pref: ThemePreference): void;
  resolved(): Theme;
}

declare global {
  interface Window {
    atelierTheme?: AtelierThemeApi;
  }
}

const media = typeof window !== "undefined" ? window.matchMedia?.("(prefers-color-scheme: dark)") : undefined;
/** Repli quand atelier-theme.js n'est pas chargé (tests) : préférence en mémoire. */
let fallbackPreference: ThemePreference = "system";

function readPreference(): ThemePreference {
  return window.atelierTheme?.get() ?? fallbackPreference;
}

function resolve(pref: ThemePreference): Theme {
  return pref === "system" ? (media?.matches ? "dark" : "light") : pref;
}

/**
 * Pose les deux marqueurs du thème sur <html> (docs/SUITE.md §1.5) : classe `dark` (variantes Tailwind)
 * et `data-theme` (variables de fondation du design system). atelier-theme.js fait de même ; cette fonction
 * sert de repli quand il est absent.
 */
export function applyThemeMarkers(theme: Theme, root: HTMLElement = document.documentElement): void {
  root.classList.toggle("dark", theme === "dark");
  root.setAttribute("data-theme", theme);
}

/** Thème réellement affiché, lu sur <html> (atelier-theme.js suit aussi le système et les autres onglets). */
function currentTheme(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/**
 * Thème de l'application : Système (suit macOS / Windows), Clair ou Sombre.
 * Préférence commune à la suite (docs/SUITE.md §1.5) : écrite par `window.atelierTheme.set` ; ce hook suit
 * l'événement `atelier-theme`, le thème du système et le retour sur la page (changement fait dans une autre app).
 */
export function useTheme(): {
  theme: Theme;
  preference: ThemePreference;
  setPreference: (p: ThemePreference) => void;
  toggle: () => void;
} {
  const [preference, setPref] = useState<ThemePreference>(readPreference);
  const [theme, setTheme] = useState<Theme>(currentTheme);

  useEffect(() => {
    const sync = () => {
      setPref(readPreference());
      setTheme(currentTheme());
    };
    // atelier-theme.js réapplique le thème sur ces mêmes événements : on relit après lui.
    const later = () => queueMicrotask(sync);
    window.addEventListener("atelier-theme", sync);
    media?.addEventListener?.("change", later);
    document.addEventListener("visibilitychange", later);
    return () => {
      window.removeEventListener("atelier-theme", sync);
      media?.removeEventListener?.("change", later);
      document.removeEventListener("visibilitychange", later);
    };
  }, []);

  const setPreference = useCallback((p: ThemePreference) => {
    if (window.atelierTheme) {
      window.atelierTheme.set(p); // pose les marqueurs et émet « atelier-theme »
      return;
    }
    fallbackPreference = p;
    applyThemeMarkers(resolve(p));
    window.dispatchEvent(new CustomEvent("atelier-theme", { detail: p }));
  }, []);

  const toggle = useCallback(() => setPreference(currentTheme() === "dark" ? "light" : "dark"), [setPreference]);

  return { theme, preference, setPreference, toggle };
}
