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

/** État des fournisseurs IA : pastille pleine = prêt, cercle vide = indisponible (sans couleur : état nominal muet), détail au survol. */
export function ProviderBadges({ providers, loading, error, onRefresh }: ProviderBadgesProps) {
  return (
    <div className="flex items-center gap-0.5">
      {error ? (
        <span className="text-xs text-negative" title={error}>
          API hors ligne
        </span>
      ) : (
        providers.map((p) => (
          <span
            key={p.name}
            title={p.detail ?? `${LABELS[p.name]} prêt — ${p.model}`}
            className={clsx("flex h-7 items-center gap-1.5 rounded-md px-2 text-xs", p.available ? "text-fg" : "text-muted")}
          >
            <span aria-hidden className={clsx("size-1.5 rounded-full", p.available ? "bg-fg/70" : "border border-faint")} />
            {LABELS[p.name]}
            <span className="sr-only">{p.available ? "disponible" : "indisponible"}</span>
          </span>
        ))
      )}
      <button
        type="button"
        onClick={onRefresh}
        aria-label="Revérifier les fournisseurs IA"
        className="grid size-[30px] place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg"
      >
        <RefreshCw className={clsx("size-3.5", loading && "animate-spin")} aria-hidden />
      </button>
    </div>
  );
}
