import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";
export type ThemePreference = Theme | "system";

const KEY = "theme";
const listeners = new Set<() => void>();
const media = typeof window !== "undefined" ? window.matchMedia?.("(prefers-color-scheme: dark)") : undefined;

function readPreference(): ThemePreference {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function resolve(pref: ThemePreference): Theme {
  return pref === "system" ? (media?.matches ? "dark" : "light") : pref;
}

/**
 * Pose les deux marqueurs du thème sur <html> (docs/SUITE.md §1.5) : classe `dark` (variantes Tailwind)
 * et `data-theme` (variables de fondation du design system).
 */
export function applyThemeMarkers(theme: Theme, root: HTMLElement = document.documentElement): void {
  root.classList.toggle("dark", theme === "dark");
  root.setAttribute("data-theme", theme);
}

function apply(pref: ThemePreference): void {
  applyThemeMarkers(resolve(pref));
  listeners.forEach((l) => l());
}

media?.addEventListener?.("change", () => {
  if (readPreference() === "system") apply("system");
});

/**
 * Thème de l'application : clair, sombre ou « système » (suit Windows / macOS).
 * Partagé entre l'en-tête et les Réglages ; mémorisé dans le navigateur.
 */
export function useTheme(): {
  theme: Theme;
  preference: ThemePreference;
  setPreference: (p: ThemePreference) => void;
  toggle: () => void;
} {
  const [preference, setPref] = useState<ThemePreference>(readPreference);
  const [theme, setTheme] = useState<Theme>(() => resolve(readPreference()));

  useEffect(() => {
    const sync = () => {
      setPref(readPreference());
      setTheme(document.documentElement.classList.contains("dark") ? "dark" : "light");
    };
    listeners.add(sync);
    return () => {
      listeners.delete(sync);
    };
  }, []);

  const setPreference = useCallback((p: ThemePreference) => {
    try {
      if (p === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, p);
    } catch {
      /* stockage indisponible (navigation privée) : le choix vaut pour la session */
    }
    apply(p);
  }, []);

  const toggle = useCallback(() => setPreference(resolve(readPreference()) === "dark" ? "light" : "dark"), [setPreference]);

  return { theme, preference, setPreference, toggle };
}
