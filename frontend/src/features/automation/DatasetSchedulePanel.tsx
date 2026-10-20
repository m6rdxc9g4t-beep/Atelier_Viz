import { CalendarClock, Loader2 } from "lucide-react";
import { useEffect, useState } from "react";

import { api } from "../../lib/api";
import type { ScheduleState } from "../../types/refresh";
import { ScheduleEditor } from "./ScheduleEditor";

/** Encart « Actualisation planifiée » de la page Données, pour le jeu sélectionné (importé d'une connexion). */
export function DatasetSchedulePanel({ datasetId, refreshedAt }: { datasetId: string; refreshedAt: string | undefined }) {
  const [state, setState] = useState<ScheduleState | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Relu quand le jeu change ou vient d'être actualisé (journal à jour).
  useEffect(() => {
    let alive = true;
    api.refresh
      .get(datasetId)
      .then((s) => alive && setState(s))
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [datasetId, refreshedAt]);

  return (
    <section aria-label="Actualisation planifiée" className="atelier-glass rounded-lg border border-border bg-surface px-4 py-3">
      <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold">
        <CalendarClock className="size-3.5 text-accent-ink" aria-hidden /> Actualisation planifiée
      </h3>
      {error ? (
        <p className="text-xs text-negative">{error}</p>
      ) : state ? (
        <ScheduleEditor state={state} onChange={setState} compact />
      ) : (
        <Loader2 className="size-4 animate-spin text-muted" aria-label="Chargement" />
      )}
    </section>
  );
}
