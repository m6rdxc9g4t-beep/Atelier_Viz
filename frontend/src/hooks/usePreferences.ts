import { useCallback, useEffect, useState } from "react";

import { api, type Preferences } from "../lib/api";

type Listener = (p: Preferences) => void;
const listeners = new Set<Listener>();
let current: Preferences | null = null;

/** Préférences partagées par toute l'application (mode en ligne), synchronisées avec le backend. */
export function usePreferences(): {
  prefs: Preferences | null;
  setOnline: (online: boolean) => Promise<void>;
  error: string | null;
} {
  const [prefs, setPrefs] = useState<Preferences | null>(current);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listeners.add(setPrefs);
    if (!current) {
      api.settings
        .get()
        .then((p) => {
          current = p;
          listeners.forEach((l) => l(p));
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    }
    return () => {
      listeners.delete(setPrefs);
    };
  }, []);

  const setOnline = useCallback(async (online: boolean) => {
    try {
      const p = await api.settings.set({ online_mode: online });
      current = p;
      listeners.forEach((l) => l(p));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  return { prefs, setOnline, error };
}
