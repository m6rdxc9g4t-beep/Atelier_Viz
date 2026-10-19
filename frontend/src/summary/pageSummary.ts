/** Résumé d'une page : faits → requête → texte (zone de texte du rapport, notes PowerPoint). */

import { loadVisual, mapLimit } from "../export/data";
import { activeFilterTexts } from "../export/notes";
import type { ProviderChoice } from "../types/ai";
import type { DatasetProfile } from "../types/dataset";
import type { Page } from "../types/report";
import type { SummaryRequest, SummaryResponse, VisualFacts } from "../types/summary";
import type { Selection } from "../visuals/types";
import { type FactsData, pageFacts } from "./facts";

/** Charge les données de la page (cache partagé avec le Studio) et en tire les faits. */
export async function loadPageFacts(page: Page, selection: Selection | null, profiles: Map<string, DatasetProfile>): Promise<VisualFacts[]> {
  const loaded = new Map<string, FactsData>();
  await mapLimit(page.visuals, 4, async (v) => {
    loaded.set(v.id, await loadVisual(page, v, selection, profiles));
  });
  return pageFacts(page, (id) => loaded.get(id));
}

export function summaryRequest(
  reportName: string,
  page: Page,
  selection: Selection | null,
  profiles: Map<string, DatasetProfile>,
  visuals: VisualFacts[],
  provider: ProviderChoice,
  maxPoints = 4,
): SummaryRequest {
  const active = activeFilterTexts(page, selection, profiles);
  return {
    report: reportName.slice(0, 200),
    page: (page.name || "Page").slice(0, 200),
    provider,
    filters: [...active.page, ...active.slicers, ...active.selection.map((s) => `sélection : ${s}`)].slice(0, 20),
    visuals,
    max_points: maxPoints,
  };
}

/** Texte d'une zone de texte du rapport : titre en gras, puis une puce par point. */
export function summaryText(s: Pick<SummaryResponse, "headline" | "points">): string {
  return [`**${s.headline}**`, ...s.points.map((p) => `- ${p.text}`)].join("\n");
}

/** Lignes des notes du présentateur. */
export function summaryNotes(s: Pick<SummaryResponse, "headline" | "points">): string[] {
  return ["Synthèse (IA, chiffres vérifiés) :", s.headline, ...s.points.map((p) => `• ${p.text}`)];
}
