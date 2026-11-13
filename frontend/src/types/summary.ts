/** Miroir de backend/app/schemas/summary.py — garder synchronisé. */

import type { ProviderChoice, ProviderName } from "./ai";
import type { VisualType } from "./report";

export interface VisualFacts {
  id: string;
  title: string;
  type: VisualType;
  facts: string[];
}

/** Constat de la lecture calculée : une phrase et les visuels d'où elle vient. */
export interface ReadingPoint {
  text: string;
  visuals: string[];
}

/** Lecture de la page calculée dans le navigateur, sans IA : point d'appui du modèle et repli s'il échoue. */
export interface SummaryReading {
  /** Phrase d'ouverture. */
  headline: string;
  /** Période couverte par la page (« août 2026 → oct. 2026 »). */
  period?: string | null;
  points: ReadingPoint[];
}

export interface SummaryRequest {
  report: string;
  page: string;
  provider: ProviderChoice;
  filters: string[];
  visuals: VisualFacts[];
  max_points?: number;
  reading?: SummaryReading | null;
}

export interface SummaryPoint {
  text: string;
  /** Identifiants des visuels concernés. */
  visuals: string[];
  /** Constat calculé sans IA, posé à la place d'une phrase écartée. */
  local?: boolean;
}

export interface SummaryResponse {
  /** Phrase d'ouverture. */
  headline: string;
  points: SummaryPoint[];
  provider: ProviderName;
  model: string;
  warnings: string[];
  /** Toute la synthèse vient de la lecture calculée (le modèle a échoué ou n'a rien donné de vérifiable). */
  local?: boolean;
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
