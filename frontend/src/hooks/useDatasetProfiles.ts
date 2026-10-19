import { useEffect, useState } from "react";

import { api } from "../lib/api";
import type { DatasetProfile } from "../types/dataset";

const cache = new Map<string, Promise<DatasetProfile>>();

export function getProfile(id: string): Promise<DatasetProfile> {
  let p = cache.get(id);
  if (!p) {
    p = api.datasets.get(id);
    cache.set(id, p);
    p.catch(() => cache.delete(id));
  }
  return p;
}

export function forgetProfile(id: string): void {
  cache.delete(id);
}

const listeners = new Set<(p: DatasetProfile) => void>();

/** Remplace un profil (après modification du modèle) et prévient les composants qui l'affichent. */
export function setProfile(profile: DatasetProfile): void {
  cache.set(profile.id, Promise.resolve(profile));
  listeners.forEach((l) => l(profile));
}

/** Profils des jeux de données demandés (chargés une fois, partagés). */
export function useDatasetProfiles(ids: (string | null | undefined)[]): Map<string, DatasetProfile> {
  const key = [...new Set(ids.filter((x): x is string => !!x))].sort().join(",");
  const [profiles, setProfiles] = useState<Map<string, DatasetProfile>>(new Map());

  useEffect(() => {
    if (!key) return;
    let alive = true;
    Promise.allSettled(key.split(",").map(getProfile)).then((results) => {
      if (!alive) return;
      setProfiles((prev) => {
        const next = new Map(prev);
        for (const r of results) if (r.status === "fulfilled") next.set(r.value.id, r.value);
        return next;
      });
    });
    return () => {
      alive = false;
    };
  }, [key]);

  useEffect(() => {
    const onChange = (p: DatasetProfile) => setProfiles((prev) => (prev.has(p.id) ? new Map(prev).set(p.id, p) : prev));
    listeners.add(onChange);
    return () => {
      listeners.delete(onChange);
    };
  }, []);

  return profiles;
}
