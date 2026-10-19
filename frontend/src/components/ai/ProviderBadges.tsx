import clsx from "clsx";
import { RefreshCw } from "lucide-react";

import type { ProviderName, ProviderStatus } from "../../types/ai";

const LABELS: Record<ProviderName, string> = { ollama: "Ollama", anthropic: "Claude" };

interface ProviderBadgesProps {
  providers: ProviderStatus[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

/** Pastilles d'état des fournisseurs IA (vert = prêt, gris = indisponible, détail au survol). */
export function ProviderBadges({ providers, loading, error, onRefresh }: ProviderBadgesProps) {
  return (
    <div className="flex items-center gap-2">
      {error ? (
        <span className="text-xs text-negative" title={error}>
          API hors ligne
        </span>
      ) : (
        providers.map((p) => (
          <span
            key={p.name}
            title={p.detail ?? `${LABELS[p.name]} prêt — ${p.model}`}
            className="flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs"
          >
            <span
              aria-hidden
              className={clsx("size-1.5 rounded-full", p.available ? "bg-positive" : "bg-muted/50")}
            />
            {LABELS[p.name]}
            <span className="sr-only">{p.available ? "disponible" : "indisponible"}</span>
          </span>
        ))
      )}
      <button
        type="button"
        onClick={onRefresh}
        aria-label="Revérifier les fournisseurs IA"
        className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-fg"
      >
        <RefreshCw className={clsx("size-3.5", loading && "animate-spin")} aria-hidden />
      </button>
    </div>
  );
}
