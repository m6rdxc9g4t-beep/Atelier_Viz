/**
 * Volet « Créer avec l'IA » : session par rapport (demande en cours, résultat affiché, historique).
 *
 * Logique pure (testée dans `aiBuilder.test.ts`) + un petit store zustand qui garde une session par
 * rapport tant que l'application est ouverte (le volet peut être fermé puis rouvert sans rien perdre).
 *
 * L'état « ajouté » d'une proposition n'est jamais mémorisé tel quel : il se déduit du rapport
 * (les identifiants des visuels créés sont-ils encore présents ?). Un Ctrl+Z qui retire le visuel
 * rend donc la proposition de nouveau « à ajouter », un Ctrl+Y la remet « ajoutée ».
 */

import { create } from "zustand";

import type { BuildResponse, ProposedVisual, RepairResponse } from "../types/builder";
import type { Report } from "../types/report";

/** Une demande passée et sa réponse. */
export interface BuildEntry {
  id: string;
  prompt: string;
  /** Horodatage (ms). */
  at: number;
  datasetId: string;
  result: BuildResponse;
  /** Visuels créés à partir de chaque proposition : index → identifiants dans le rapport. */
  added: Record<number, string[]>;
}

/** Génération en cours (le volet peut être fermé pendant l'attente). */
export interface PendingBuild {
  prompt: string;
  startedAt: number;
}

/** Session du volet pour un rapport. */
export interface BuilderSession {
  /** Texte de la zone « Votre demande ». */
  draft: string;
  /** « Jusqu'à n visuels ». */
  count: number;
  /** Entrée affichée comme résultat courant (null = aucune, après « Nouvelle demande »). */
  currentId: string | null;
  /** Historique, la plus récente d'abord. */
  entries: BuildEntry[];
  pending: PendingBuild | null;
  error: string | null;
}

/** Nombre d'entrées gardées par rapport. */
export const MAX_ENTRIES = 20;

/** État d'une proposition par rapport au rapport : jamais ajoutée, ajoutée, ou retirée depuis (Ctrl+Z, suppression). */
export type Placement = "new" | "placed" | "removed";

export function emptySession(): BuilderSession {
  return { draft: "", count: 3, currentId: null, entries: [], pending: null, error: null };
}

/** Enregistre une réponse : elle devient le résultat affiché et la tête de l'historique. */
export function recordResult(s: BuilderSession, entry: BuildEntry): BuilderSession {
  return { ...s, entries: [entry, ...s.entries.filter((e) => e.id !== entry.id)].slice(0, MAX_ENTRIES), currentId: entry.id, pending: null, error: null };
}

/** « Nouvelle demande » : vide la demande et le résultat affiché (l'historique reste). */
export function newRequest(s: BuilderSession): BuilderSession {
  return { ...s, draft: "", currentId: null, error: null };
}

/** Réaffiche une demande passée comme résultat courant, avec son texte dans la zone de demande. */
export function showEntry(s: BuilderSession, entryId: string): BuilderSession {
  const entry = s.entries.find((e) => e.id === entryId);
  return entry ? { ...s, currentId: entry.id, draft: entry.prompt, error: null } : s;
}

/** Retient les visuels créés pour une entrée (index de proposition → identifiants). */
export function recordAdded(s: BuilderSession, entryId: string, created: Record<number, string[]>): BuilderSession {
  return {
    ...s,
    entries: s.entries.map((e) => {
      if (e.id !== entryId) return e;
      const added = { ...e.added };
      for (const [k, ids] of Object.entries(created)) {
        const i = Number(k);
        added[i] = [...(added[i] ?? []), ...ids];
      }
      return { ...e, added };
    }),
  };
}

/** Résultat affiché, s'il existe encore. */
export function currentEntry(s: BuilderSession): BuildEntry | null {
  return s.entries.find((e) => e.id === s.currentId) ?? null;
}

/** Demandes précédentes : tout l'historique sauf le résultat affiché. */
export function previousEntries(s: BuilderSession): BuildEntry[] {
  return s.entries.filter((e) => e.id !== s.currentId);
}

/** Identifiants de tous les visuels du rapport (toutes pages). */
export function visualIds(report: Report | null): Set<string> {
  return new Set(report?.pages.flatMap((p) => p.visuals.map((v) => v.id)) ?? []);
}

/** Où en est la proposition `index` de l'entrée, d'après le rapport actuel. */
export function placement(entry: BuildEntry, index: number, ids: Set<string>): Placement {
  const created = entry.added[index] ?? [];
  if (created.some((id) => ids.has(id))) return "placed";
  return created.length ? "removed" : "new";
}

/** Propositions qui ne sont pas (ou plus) sur le rapport. */
export function addableIndexes(entry: BuildEntry, ids: Set<string>): number[] {
  return entry.result.visuals.map((_, i) => i).filter((i) => placement(entry, i, ids) !== "placed");
}

/** Nombre de propositions de l'entrée actuellement sur le rapport. */
export function placedCount(entry: BuildEntry, ids: Set<string>): number {
  return entry.result.visuals.filter((_, i) => placement(entry, i, ids) === "placed").length;
}

/**
 * Associe la réponse de `/api/ai/visuals/repair` (un résultat par visuel envoyé, dans l'ordre)
 * aux index des propositions : visuels réparés à ajouter, et visuels écartés avec leur raison.
 */
export function mapRepaired(
  indexes: number[],
  response: RepairResponse,
): { specs: ProposedVisual[]; indexes: number[]; dropped: { index: number; reason: string }[] } {
  const specs: ProposedVisual[] = [];
  const kept: number[] = [];
  const dropped: { index: number; reason: string }[] = [];
  indexes.forEach((index, n) => {
    const r = response.results[n];
    if (r?.visual) {
      specs.push(r.visual);
      kept.push(index);
    } else {
      dropped.push({ index, reason: r?.errors[0] ?? "visuel invalide" });
    }
  });
  return { specs, indexes: kept, dropped };
}

/** Répartit les identifiants créés (dans l'ordre des visuels ajoutés) par index de proposition. */
export function createdByIndex(indexes: number[], ids: string[]): Record<number, string[]> {
  const out: Record<number, string[]> = {};
  indexes.forEach((index, n) => {
    const id = ids[n];
    if (id) out[index] = [...(out[index] ?? []), id];
  });
  return out;
}

/** Identifiant d'entrée (unique dans la session). */
export function entryId(now = Date.now()): string {
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface BuilderStore {
  sessions: Record<string, BuilderSession>;
  /** Applique une transformation à la session d'un rapport (créée au besoin). */
  update: (reportId: string, fn: (s: BuilderSession) => BuilderSession) => void;
}

/** Sessions du volet, par rapport, en mémoire tant que l'application est ouverte. */
export const useAIBuilder = create<BuilderStore>((set) => ({
  sessions: {},
  update: (reportId, fn) => set((st) => ({ sessions: { ...st.sessions, [reportId]: fn(st.sessions[reportId] ?? emptySession()) } })),
}));

const EMPTY = emptySession();

/** Session d'un rapport (vide si aucune). */
export function useBuilderSession(reportId: string | undefined): BuilderSession {
  return useAIBuilder((st) => (reportId ? st.sessions[reportId] : undefined) ?? EMPTY);
}
