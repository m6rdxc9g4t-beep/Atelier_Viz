/**
 * Exemples de la suite : histoires fictives qui traversent toutes les apps (format `atelier-exemples/1`).
 * Logique pure du panneau « Exemples de la suite » : noms des apps, étape courante, étape suivante, histoire mémorisée.
 */

import type { ExempleEtape, ExempleHistoire, SuiteExampleApp } from "../types/exemples";

/** Noms affichés des apps du parcours, dans l'ordre de la suite. */
export const APP_LABELS: Record<SuiteExampleApp, string> = {
  convert: "Convert",
  tab: "Tab",
  viz: "Viz",
  tresorerie: "Trésorerie",
  nexus: "Nexus",
  projets: "Projets",
  wiki: "Wiki",
};

/** App courante. */
export const THIS_APP: SuiteExampleApp = "viz";

/** Clé de l'histoire choisie, mémorisée sur l'appareil (commune aux apps servies depuis la même origine). */
export const STORAGE_KEY = "atelier:exemple";

/** Étape de l'app `app` dans le parcours de l'histoire, et la suivante (null en fin de parcours). */
export function stepsAround(
  histoire: Pick<ExempleHistoire, "parcours">,
  app: SuiteExampleApp = THIS_APP,
): { index: number; current: ExempleEtape | null; next: ExempleEtape | null } {
  const index = histoire.parcours.findIndex((e) => e.app === app);
  return {
    index,
    current: index >= 0 ? (histoire.parcours[index] ?? null) : null,
    next: index >= 0 ? (histoire.parcours[index + 1] ?? null) : null,
  };
}

/** Histoire à afficher : celle mémorisée si elle existe encore, sinon la première. */
export function pickHistoire(histoires: ExempleHistoire[], remembered: string | null): ExempleHistoire | null {
  return histoires.find((h) => h.id === remembered) ?? histoires[0] ?? null;
}

export function readRemembered(storage: Pick<Storage, "getItem"> | undefined = globalThis.localStorage): string | null {
  try {
    return storage?.getItem(STORAGE_KEY) ?? null;
  } catch {
    return null;
  }
}

export function remember(id: string, storage: Pick<Storage, "setItem"> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(STORAGE_KEY, id);
  } catch {
    // stockage indisponible (navigation privée, iframe) : le choix n'est simplement pas gardé
  }
}
