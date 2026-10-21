/** « Expliquer cette valeur » : requêtes (moteur local, cache partagé) puis constats. */

import { loadVisual, mapLimit } from "../export/data";
import type { DatasetProfile } from "../types/dataset";
import type { Page, Visual } from "../types/report";
import { drillView } from "../visuals/drill";
import type { Selection } from "../visuals/types";
import { runQuery } from "../visuals/useQueryResult";
import { type DimensionBreakdown, type ExplainTarget, bestDimensions, breakdown, candidateDimensions, dimensionRequests, explainFacts, explainTarget } from "./explain";

export interface Explanation {
  target: ExplainTarget;
  dimensions: DimensionBreakdown[];
  facts: string[];
  /** Filtres du visuel (hors élément expliqué), en clair côté appelant. */
  title: string;
}

/** Décompose l'élément sélectionné d'un visuel ; message d'explication si ce n'est pas possible. */
export async function runExplain(page: Page, visual: Visual, selection: Selection, profiles: Map<string, DatasetProfile>): Promise<Explanation | string> {
  const view = drillView(visual);
  const profile = view.dataset_id ? profiles.get(view.dataset_id) : undefined;
  if (!view.dataset_id || !profile) return "Jeu de données introuvable.";
  const loaded = await loadVisual(page, view, selection, profiles);
  const target = explainTarget(view, loaded.result, selection, profile);
  if (typeof target === "string") return target;
  const dims = candidateDimensions(profile, target.axis.field).filter((c) => !Object.values(view.roles).flat().some((b) => !b.agg && b.field === c.name && b.field !== target.axis.field));
  if (!dims.length) return "Aucune autre dimension (texte, 2 à 50 valeurs) pour décomposer cette valeur.";
  const datasetId = view.dataset_id;
  const list = await mapLimit(dims, 3, async (d) => {
    const reqs = dimensionRequests(datasetId, target, d.name, loaded.filters);
    const [cur, base] = await Promise.all([runQuery(reqs.current), runQuery(reqs.base)]);
    return breakdown(target, d.name, cur, base);
  });
  const best = bestDimensions(list);
  const axisType = profile.columns.find((c) => c.name === target.axis.field)?.type;
  return { target, dimensions: best, facts: explainFacts(view, target, best, axisType), title: view.title ?? "" };
}
