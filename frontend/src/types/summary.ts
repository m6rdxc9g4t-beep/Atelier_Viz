/** Miroir de backend/app/schemas/summary.py — garder synchronisé. */

import type { ProviderChoice, ProviderName } from "./ai";
import type { VisualType } from "./report";

export interface VisualFacts {
  id: string;
  title: string;
  type: VisualType;
  facts: string[];
}

export interface SummaryRequest {
  report: string;
  page: string;
  provider: ProviderChoice;
  filters: string[];
  visuals: VisualFacts[];
  max_points?: number;
}

export interface SummaryPoint {
  text: string;
  /** Identifiants des visuels concernés. */
  visuals: string[];
}

export interface SummaryResponse {
  headline: string;
  points: SummaryPoint[];
  provider: ProviderName;
  model: string;
  warnings: string[];
}

/** Question en langage naturel (ou explication d'un écart), avec les faits calculés ici. */
export interface AnswerRequest {
  question: string;
  provider: ProviderChoice;
  filters: string[];
  visuals: VisualFacts[];
  kind?: "question" | "explain";
}

export interface AnswerResponse {
  answer: string;
  provider: ProviderName;
  model: string;
  /** Phrases écartées (chiffre non vérifiable). */
  warnings: string[];
}
