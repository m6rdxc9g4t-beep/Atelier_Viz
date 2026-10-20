import { useCallback, useEffect, useState } from "react";

import { api, type Preferences } from "../lib/api";

type Listener = (p: Preferences) => void;
const listeners = new Set<Listener>();
let current: Preferences | null = null;

/** Diffuse de nouvelles préférences à tous les composants abonnés. */
function publish(p: Preferences) {
  current = p;
  listeners.forEach((l) => l(p));
}

/**
 * Préférences partagées par toute l'application (mode en ligne, moteur et modèles d'IA),
 * synchronisées avec le backend. `update` n'envoie que les champs modifiés.
 */
export function usePreferences(): {
  prefs: Preferences | null;
  setOnline: (online: boolean) => Promise<void>;
  update: (patch: Partial<Preferences>) => Promise<void>;
  error: string | null;
} {
  const [prefs, setPrefs] = useState<Preferences | null>(current);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listeners.add(setPrefs);
    if (!current) {
      api.settings
        .get()
        .then(publish)
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    }
    return () => {
      listeners.delete(setPrefs);
    };
  }, []);

  const update = useCallback(async (patch: Partial<Preferences>) => {
    // Affichage immédiat, puis valeur confirmée par le serveur.
    if (current) publish({ ...current, ...patch });
    try {
      publish(await api.settings.set(patch));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      api.settings.get().then(publish, () => undefined);
    }
  }, []);

  const setOnline = useCallback((online: boolean) => update({ online_mode: online }), [update]);

  return { prefs, setOnline, update, error };
}

/** Tests : oublie les préférences en mémoire. */
export function resetPreferencesCache() {
  current = null;
}
