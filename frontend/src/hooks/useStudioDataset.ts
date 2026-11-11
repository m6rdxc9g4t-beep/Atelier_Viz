import { useEffect, useState } from "react";

import type { Report } from "../types/report";

/** Jeu de données d'un rapport : celui du rapport, sinon celui de son premier visuel relié à des données. */
export function reportDatasetId(report: Pick<Report, "dataset_id" | "pages"> | null | undefined): string | undefined {
  if (!report) return undefined;
  return report.dataset_id ?? report.pages.flatMap((p) => p.visuals).find((v) => v.dataset_id)?.dataset_id ?? undefined;
}

/**
 * Jeu de données du rapport ouvert dans le Studio (pour l'assistant). Le store du Studio embarque le registre des
 * visuels (graphiques, cartes) : il n'est lu qu'une fois le Studio ouvert, par un import à la demande, pour rester
 * hors du paquet initial (accueil, Données, Réglages).
 */
export function useStudioDatasetId(inStudio: boolean): string | undefined {
  const [id, setId] = useState<string>();

  useEffect(() => {
    if (!inStudio) {
      setId(undefined);
      return;
    }
    let alive = true;
    let unsubscribe: (() => void) | undefined;
    void import("../studio/store").then(({ useStudio }) => {
      if (!alive) return;
      const read = () => setId(reportDatasetId(useStudio.getState().report));
      read();
      unsubscribe = useStudio.subscribe(read);
    });
    return () => {
      alive = false;
      unsubscribe?.();
    };
  }, [inStudio]);

  return id;
}
