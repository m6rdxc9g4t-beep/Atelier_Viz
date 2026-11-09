/**
 * Paramètres de simulation (« what-if » de Power BI).
 *
 * Un visuel « Paramètre » pose un curseur sur la page : nom, bornes, pas, valeur par défaut ; la
 * valeur choisie est enregistrée dans `options.value` (comme la sélection d'un segment). Une mesure
 * calculée la lit avec `PARAM("nom", défaut)` ; chaque requête de la page envoie les valeurs
 * des curseurs qu'elle utilise (`QueryRequest.parameters`). Comme les segments, un curseur agit
 * sur les visuels de sa page ; ailleurs (alertes, autres pages), la mesure prend son défaut.
 */

import type { DatasetProfile } from "../../types/dataset";
import type { QueryRequest } from "../../types/query";
import type { Page, Visual } from "../../types/report";

export interface ParameterSpec {
  name: string;
  min: number;
  max: number;
  step: number;
  default: number;
  /** Valeur courante, bornée et alignée sur le pas. */
  value: number;
}

export const PARAMETER_DEFAULTS = { name: "croissance", min: 0, max: 20, step: 1, default: 5 } as const;

/** Nom valide : comme `PARAMETER_NAME` côté moteur (lettre ou chiffre, puis lettres, chiffres, espaces, _ ou -). */
const NAME = /^[\p{L}\p{N}_][\p{L}\p{N}_ -]{0,59}$/u;

const num = (v: unknown, fallback: number): number => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : fallback;
};

/** Nombre sans bruit d'arrondi binaire (0,1 + 0,2 → 0,3). */
const tidy = (n: number) => Number.parseFloat(n.toPrecision(12));

/** Valeur ramenée dans [min, max] et sur la grille du pas. */
export function clampToStep(value: number, min: number, max: number, step: number): number {
  const bounded = Math.min(max, Math.max(min, value));
  if (!(step > 0)) return tidy(bounded);
  return tidy(Math.min(max, min + Math.round((bounded - min) / step) * step));
}

/** Définition d'un curseur (options lues avec repli), ou null si ce n'est pas un paramètre valide. */
export function parameterSpec(visual: Visual): ParameterSpec | null {
  if (visual.type !== "parameter") return null;
  const o = visual.options;
  const name = (typeof o.name === "string" ? o.name : PARAMETER_DEFAULTS.name).trim();
  if (!NAME.test(name)) return null;
  let min = num(o.min, PARAMETER_DEFAULTS.min);
  let max = num(o.max, PARAMETER_DEFAULTS.max);
  if (min > max) [min, max] = [max, min];
  const step = Math.abs(num(o.step, PARAMETER_DEFAULTS.step)) || PARAMETER_DEFAULTS.step;
  const def = clampToStep(num(o.default, PARAMETER_DEFAULTS.default), min, max, step);
  const value = clampToStep(num(o.value, def), min, max, step);
  return { name, min, max, step, default: def, value };
}

/** Valeurs des curseurs d'une page (nom → valeur) ; à nom égal, le premier curseur l'emporte. */
export function pageParameters(page: Pick<Page, "visuals">): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of page.visuals) {
    const spec = parameterSpec(v);
    if (spec && !(spec.name in out)) out[spec.name] = spec.value;
  }
  return out;
}

const PARAM_CALL = /PARAM(?:ETRE|ÈTRE)?\s*\(\s*(?:"([^"]*)"|'([^']*)')/giu;

/** Noms de paramètres cités par les mesures d'un jeu de données. */
export function usedParameterNames(profile: DatasetProfile | undefined): Set<string> {
  const names = new Set<string>();
  for (const m of profile?.model?.measures ?? []) {
    for (const match of m.expression.matchAll(PARAM_CALL)) names.add((match[1] ?? match[2] ?? "").trim());
  }
  return names;
}

/**
 * Ajoute à une requête les valeurs des curseurs que les mesures de son jeu utilisent (seulement
 * celles-là : un curseur ne relance pas les visuels qu'il ne concerne pas). Profil inconnu : toutes.
 */
export function withParameters(req: QueryRequest | null, params: Record<string, number>, profile?: DatasetProfile): QueryRequest | null {
  if (!req) return null;
  const used = profile ? usedParameterNames(profile) : null;
  const entries = Object.entries(params).filter(([name]) => !used || used.has(name));
  return entries.length ? { ...req, parameters: Object.fromEntries(entries) } : req;
}
