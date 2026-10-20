import { useCallback, useEffect, useState } from "react";

import { api } from "../lib/api";
import type { ProviderStatus } from "../types/ai";

interface ProvidersState {
  providers: ProviderStatus[];
  loading: boolean;
  error: string | null;
  /** Revérifie (`force` : sans le cache de 60 s du serveur pour Claude). */
  refresh: (force?: boolean) => void;
}

interface Shared {
  providers: ProviderStatus[];
  loading: boolean;
  error: string | null;
}

// État partagé : pastilles de l'en-tête, réglages et volets d'IA voient la même chose.
let shared: Shared = { providers: [], loading: true, error: null };
let loaded = false;
const listeners = new Set<(s: Shared) => void>();

function publish(next: Partial<Shared>) {
  shared = { ...shared, ...next };
  listeners.forEach((l) => l(shared));
}

function load(force = false) {
  loaded = true;
  publish({ loading: true });
  api
    .providers(force)
    .then((res) => publish({ providers: res.providers, error: null }))
    .catch((err: unknown) => publish({ error: err instanceof Error ? err.message : String(err) }))
    .finally(() => publish({ loading: false }));
}

/** État d'Ollama et de Claude (/api/ai/providers), interrogé une fois puis à la demande. */
export function useProviders(): ProvidersState {
  const [state, setState] = useState<Shared>(shared);

  useEffect(() => {
    listeners.add(setState);
    if (!loaded) load();
    else setState(shared);
    return () => {
      listeners.delete(setState);
    };
  }, []);

  const refresh = useCallback((force = false) => load(force), []);
  return { ...state, refresh };
}

/** Tests : oublie l'état en mémoire. */
export function resetProvidersCache() {
  shared = { providers: [], loading: true, error: null };
  loaded = false;
}
