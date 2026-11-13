/** Résumé d'une page : faits → requête → texte (zone de texte du rapport, notes PowerPoint). */

import { loadVisual, mapLimit } from "../export/data";
import { activeFilterTexts } from "../export/notes";
import type { ProviderChoice } from "../types/ai";
import type { DatasetProfile } from "../types/dataset";
import type { Page } from "../types/report";
import type { SummaryReading, SummaryRequest, SummaryResponse, VisualFacts } from "../types/summary";
import type { Selection } from "../visuals/types";
import { type FactsData, pageAnalyses } from "./facts";
import { pageReading } from "./reading";

/** Ce qui part pour un résumé : les faits de chaque visuel et la lecture calculée de la page. */
export interface PageBrief {
  visuals: VisualFacts[];
  reading: SummaryReading | null;
}

/** Filtres actifs de la page, en clair (filtres de page, segments, sélection). */
export function activeFilters(page: Page, selection: Selection | null, profiles: Map<string, DatasetProfile>): string[] {
  const active = activeFilterTexts(page, selection, profiles);
  return [...active.page, ...active.slicers, ...active.selection.map((s) => `sélection : ${s}`)].slice(0, 20);
}

/** Faits et lecture calculée d'une page, à partir des résultats déjà chargés (aucun appel à l'IA). */
export function pageBrief(page: Page, dataOf: (visualId: string) => FactsData | undefined, filters: string[] = []): PageBrief {
  const items = pageAnalyses(page, dataOf);
  return {
    visuals: items.map(({ visual, title, analysis }) => ({ id: visual.id, title, type: visual.type, facts: analysis.facts })),
    reading: pageReading(page, items, filters),
  };
}

/** Charge les données de la page (cache partagé avec le Studio) et en tire les faits et la lecture calculée. */
export async function loadPageBrief(page: Page, selection: Selection | null, profiles: Map<string, DatasetProfile>): Promise<PageBrief> {
  const loaded = new Map<string, FactsData>();
  await mapLimit(page.visuals, 4, async (v) => {
    loaded.set(v.id, await loadVisual(page, v, selection, profiles));
  });
  return pageBrief(page, (id) => loaded.get(id), activeFilters(page, selection, profiles));
}

export function summaryRequest(
  reportName: string,
  page: Page,
  selection: Selection | null,
  profiles: Map<string, DatasetProfile>,
  brief: PageBrief,
  provider: ProviderChoice,
  maxPoints = 4,
): SummaryRequest {
  return {
    report: reportName.slice(0, 200),
    page: (page.name || "Page").slice(0, 200),
    provider,
    filters: activeFilters(page, selection, profiles),
    visuals: brief.visuals,
    max_points: maxPoints,
    reading: brief.reading,
  };
}

/** Texte d'une zone de texte du rapport : titre en gras, puis une puce par point. */
export function summaryText(s: Pick<SummaryResponse, "headline" | "points">): string {
  return [`**${s.headline}**`, ...s.points.map((p) => `- ${p.text}`)].join("\n");
}

/** Lignes des notes du présentateur. */
export function summaryNotes(s: Pick<SummaryResponse, "headline" | "points" | "local">): string[] {
  return [s.local ? "Synthèse (calculée sans IA) :" : "Synthèse (IA, chiffres vérifiés) :", s.headline, ...s.points.map((p) => `• ${p.text}`)];
}
