import { useEffect, useMemo, useState } from "react";

import { api } from "../lib/api";
import { invalidateQueries } from "../visuals/useQueryResult";
import { noteVersion } from "./useDataVersions";
import type { DatasetProfile } from "../types/dataset";

const cache = new Map<string, Promise<DatasetProfile>>();
/** Profils déjà reçus : lecture synchrone des relations (jeux dépendants). */
const resolved = new Map<string, DatasetProfile>();

export function getProfile(id: string): Promise<DatasetProfile> {
  let p = cache.get(id);
  if (!p) {
    p = api.datasets.get(id);
    cache.set(id, p);
    p.then(
      (r) => resolved.set(r.id, r),
      () => cache.delete(id),
    );
  }
  return p;
}

export function forgetProfile(id: string): void {
  cache.delete(id);
  resolved.delete(id);
}

/** Jeux connus qui dépendent de `id` par une relation (directement ou en chaîne). */
export function dependentsOf(id: string, profiles: Iterable<DatasetProfile> = resolved.values()): string[] {
  const all = [...profiles];
  const out = new Set<string>();
  let frontier = [id];
  while (frontier.length) {
    const next: string[] = [];
    for (const p of all) {
      if (out.has(p.id) || p.id === id) continue;
      if ((p.model?.relations ?? []).some((r) => frontier.includes(r.dataset_id))) {
        out.add(p.id);
        next.push(p.id);
      }
    }
    frontier = next;
  }
  return [...out];
}

/**
 * Les données ou le modèle d'un jeu ont changé : ses visuels se rechargent, ainsi que ceux des jeux
 * qui lui sont liés (leurs colonnes liées viennent de lui), dont le profil est relu.
 */
export function datasetChanged(id: string): void {
  invalidateQueries(id);
  for (const dep of dependentsOf(id)) {
    invalidateQueries(dep);
    forgetProfile(dep);
    getProfile(dep).then(setProfile, () => undefined);
  }
}

const listeners = new Set<(p: DatasetProfile) => void>();

/** Remplace un profil (après modification du modèle) et prévient les composants qui l'affichent. */
export function setProfile(profile: DatasetProfile): void {
  cache.set(profile.id, Promise.resolve(profile));
  resolved.set(profile.id, profile);
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

/**
 * Relit la source d'un jeu importé depuis une connexion : nouveau profil partagé, et les visuels
 * qui l'utilisent se rechargent.
 */
export async function refreshDataset(id: string): Promise<DatasetProfile> {
  const profile = await api.datasets.refresh(id);
  noteVersion(id, profile.origin?.refreshed_at);
  setProfile(profile);
  datasetChanged(id);
  return profile;
}

/** Profils demandés + ceux des jeux liés par une relation (en chaîne), pour propager les filtres. */
export function useLinkedProfiles(ids: (string | null | undefined)[]): Map<string, DatasetProfile> {
  const [extra, setExtra] = useState<string[]>([]);
  const all = useMemo(() => [...ids, ...extra], [ids, extra]);
  const profiles = useDatasetProfiles(all);
  useEffect(() => {
    const known = new Set(all.filter((x): x is string => !!x));
    const missing = [...profiles.values()].flatMap((p) => (p.model?.relations ?? []).map((r) => r.dataset_id)).filter((x) => !known.has(x));
    if (missing.length) setExtra((cur) => [...new Set([...cur, ...missing])]);
  }, [profiles, all]);
  return profiles;
}
