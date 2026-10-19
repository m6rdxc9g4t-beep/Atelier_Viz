import { useCallback, useEffect, useState } from "react";

import { api } from "../lib/api";
import type { ProviderStatus } from "../types/ai";

interface ProvidersState {
  providers: ProviderStatus[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/** Interroge /api/ai/providers au montage, puis à la demande. */
export function useProviders(): ProvidersState {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    api
      .providers()
      .then((res) => {
        setProviders(res.providers);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(refresh, [refresh]);

  return { providers, loading, error, refresh };
}
