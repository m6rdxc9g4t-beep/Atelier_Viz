/**
 * Rechargement automatique après une actualisation planifiée : le front interroge régulièrement
 * l'horodatage de version de chaque jeu actualisable (`GET /api/refresh/versions`). Quand il change,
 * le profil est relu et les visuels du jeu se rechargent (`datasetChanged`, jeux liés compris).
 */

import { useEffect } from "react";

import { api } from "../lib/api";
import type { DatasetProfile } from "../types/dataset";
import { datasetChanged, setProfile } from "./useDatasetProfiles";

export const POLL_MS = 20_000;

const known = new Map<string, string>();
const listeners = new Set<(profile: DatasetProfile) => void>();

/** Jeux dont la version a changé depuis la dernière lecture (un jeu jamais vu n'est pas « changé »). */
export function changedDatasets(previous: ReadonlyMap<string, string>, next: Record<string, string>): string[] {
  return Object.entries(next)
    .filter(([id, version]) => previous.has(id) && previous.get(id) !== version)
    .map(([id]) => id);
}

/** Retient la version d'un jeu actualisé par l'utilisateur (évite un second rechargement au prochain passage). */
export function noteVersion(datasetId: string, version: string | null | undefined): void {
  if (version) known.set(datasetId, version);
}

/** Abonnement aux jeux actualisés en arrière-plan (liste de la page Données…). */
export function onDatasetRefreshed(listener: (profile: DatasetProfile) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Un passage : compare les versions et recharge ce qui a changé. Exporté pour les tests. */
export async function pollVersions(): Promise<string[]> {
  const next = await api.refresh.versions();
  const changed = changedDatasets(known, next);
  for (const [id, version] of Object.entries(next)) known.set(id, version);
  for (const id of changed) {
    try {
      const profile = await api.datasets.get(id);
      setProfile(profile);
      listeners.forEach((l) => l(profile));
    } catch {
      // Jeu supprimé entre-temps : rien à recharger.
    }
    datasetChanged(id);
  }
  return changed;
}

/** Interroge les versions tant que l'application est ouverte (et visible). */
export function useDataVersions(): void {
  useEffect(() => {
    let alive = true;
    const run = () => {
      if (document.visibilityState === "hidden") return;
      pollVersions().catch(() => {
        /* backend momentanément injoignable : prochain passage */
      });
    };
    run();
    const timer = setInterval(() => alive && run(), POLL_MS);
    document.addEventListener("visibilitychange", run);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", run);
    };
  }, []);
}
