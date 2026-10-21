/**
 * Questions en langage naturel : la question devient un visuel (constructeur IA, validé), calculé ici
 * par le moteur avec les filtres de la page ; ses constats partent à l'IA qui répond en 1 à 3 phrases,
 * chaque chiffre étant vérifié côté serveur. Les lignes du jeu ne quittent jamais la machine.
 */

import { loadVisual } from "../export/data";
import { activeFilterTexts } from "../export/notes";
import { api } from "../lib/api";
import type { ProviderChoice } from "../types/ai";
import type { ProposedVisual } from "../types/builder";
import type { DatasetProfile } from "../types/dataset";
import type { Page, Visual } from "../types/report";
import type { AnswerResponse } from "../types/summary";
import { aiCatalog } from "../visuals/catalog";
import type { Selection } from "../visuals/types";
import type { QueryResult } from "../visuals/useQueryResult";
import { visualFacts } from "./facts";

export interface Asked {
  proposal: ProposedVisual;
  visual: Visual;
  result: QueryResult | null;
  facts: string[];
  answer: AnswerResponse | null;
  /** Réponse rédigée indisponible (le visuel reste affiché). */
  answerError: string | null;
}

/** Visuel provisoire (aperçu dans le volet) tiré d'une proposition. */
export function previewVisual(p: ProposedVisual, datasetId: string, id: string): Visual {
  return { id, type: p.type, title: p.title ?? null, layout: { x: 0, y: 0, w: 560, h: 280 }, dataset_id: datasetId, roles: p.roles, options: p.options, filters: [] };
}

/** Suggestions de questions d'après le profil du jeu (une mesure, une dimension, une date). */
export function suggestions(profile: DatasetProfile | undefined): string[] {
  if (!profile) return [];
  const cols = profile.columns.filter((c) => !c.measure && !c.related);
  // Mesure la plus « parlante » : la plus grande moyenne (chiffre d'affaires plutôt que quantité), hors identifiants.
  const num = cols
    .filter((c) => c.type === "number" && !/(^id$|_id$|^id_|code|lat|lon|annee|year)/i.test(c.name))
    .sort((a, b) => (b.mean ?? 0) - (a.mean ?? 0))[0];
  const dim = cols.find((c) => c.type === "string" && c.distinct >= 2 && c.distinct <= 50);
  const date = cols.find((c) => c.type === "date");
  const out: string[] = [];
  if (num && dim) out.push(`Quel ${dim.name} a le plus de ${num.name} ?`);
  if (num && date) out.push(`Comment évolue ${num.name} par mois ?`);
  if (num) out.push(`Quel est le total de ${num.name} ?`);
  if (dim) out.push(`Combien de lignes par ${dim.name} ?`);
  return out.slice(0, 4);
}

export async function ask(input: {
  question: string;
  datasetId: string;
  page: Page;
  selection: Selection | null;
  profiles: Map<string, DatasetProfile>;
  provider: ProviderChoice;
  previewId: string;
  signal?: AbortSignal;
}): Promise<Asked> {
  const built = await api.buildVisuals(
    {
      prompt: `Question de l'utilisateur, à laquelle UN visuel doit répondre (de préférence un KPI pour un chiffre unique, sinon un graphique trié) : ${input.question}`.slice(0, 2000),
      dataset_id: input.datasetId,
      provider: input.provider,
      catalog: aiCatalog(),
      max_visuals: 1,
      existing: [],
    },
    input.signal,
  );
  const proposal = built.visuals[0];
  if (!proposal) throw new Error(built.explanation || "Aucun visuel ne répond à cette question avec ces données.");
  const visual = previewVisual(proposal, input.datasetId, input.previewId);
  // Mêmes filtres que la page (filtres de page, segments, sélection) : la réponse suit l'écran.
  const page = { ...input.page, visuals: [...input.page.visuals, visual] };
  const loaded = await loadVisual(page, visual, input.selection, input.profiles);
  const facts = visualFacts(visual, loaded);
  let answer: AnswerResponse | null = null;
  let answerError: string | null = loaded.error;
  if (facts.length) {
    const active = activeFilterTexts(input.page, input.selection, input.profiles);
    try {
      answer = await api.answer(
        {
          question: input.question.slice(0, 500),
          provider: input.provider,
          filters: [...active.page, ...active.slicers, ...active.selection].slice(0, 20),
          visuals: [{ id: visual.id, title: (visual.title ?? "Réponse").slice(0, 200), type: visual.type, facts }],
        },
        input.signal,
      );
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      answerError = e instanceof Error ? e.message : String(e);
    }
  }
  return { proposal, visual, result: loaded.result, facts, answer, answerError };
}
