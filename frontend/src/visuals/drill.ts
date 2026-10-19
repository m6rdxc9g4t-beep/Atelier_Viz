/**
 * Exploration par niveaux (drill-down), comme dans Power BI.
 *
 * Plusieurs champs dans l'Axe d'un graphique forment une hiérarchie (région → département → ville,
 * ou année → trimestre → mois). L'état d'exploration est enregistré dans `options.drill` :
 * - `level` : niveau affiché (0 = premier champ) ;
 * - `path`  : pour chaque niveau au-dessus, la valeur explorée, ou `null` (« niveau suivant » :
 *   tous les membres du niveau parent).
 *
 * `drillView` produit le visuel « tel qu'affiché » : un seul champ dans l'Axe et des filtres pour le
 * chemin. Requêtes, composants, export et résumé travaillent tous sur cette vue.
 */

import type { DatasetProfile, Scalar } from "../types/dataset";
import type { DateBin, Filter } from "../types/query";
import type { FieldBinding, Visual } from "../types/report";
import { role } from "./common";
import { bindingLabel } from "./fields";
import { formatDimension } from "./format";

/** Types de visuels explorables (un Axe catégoriel). */
export const DRILLABLE = new Set<Visual["type"]>(["column", "bar", "line", "area", "combo", "pie", "donut", "treemap", "funnel", "waterfall"]);

export const MAX_LEVELS = 4;

export interface DrillState {
  level: number;
  path: ({ value: Scalar } | null)[];
}

/** Champs de la hiérarchie (vide si le visuel n'est pas explorable). */
export function drillLevels(visual: Visual): FieldBinding[] {
  return DRILLABLE.has(visual.type) ? role(visual, "category").slice(0, MAX_LEVELS) : [];
}

export function canDrill(visual: Visual): boolean {
  return drillLevels(visual).length > 1;
}

/** État courant, borné aux niveaux existants (une hiérarchie raccourcie reste cohérente). */
export function drillState(visual: Visual): DrillState {
  const levels = drillLevels(visual);
  const raw = visual.options.drill as Partial<DrillState> | undefined;
  const level = Math.max(0, Math.min(levels.length - 1, Number(raw?.level ?? 0) || 0));
  const path = (Array.isArray(raw?.path) ? raw.path : []).slice(0, level);
  while (path.length < level) path.push(null);
  return { level, path };
}

/** Visuel tel qu'affiché au niveau courant : Axe = champ du niveau, filtres = chemin exploré. */
export function drillView(visual: Visual): Visual {
  if (!canDrill(visual)) return visual;
  const levels = drillLevels(visual);
  const { level, path } = drillState(visual);
  const current = levels[level] as FieldBinding;
  const filters: Filter[] = [];
  path.forEach((step, i) => {
    const b = levels[i];
    if (step && b) filters.push({ field: b.field, op: "in", values: [step.value], bin: (b.bin ?? null) as DateBin | null });
  });
  return { ...visual, roles: { ...visual.roles, category: [current] }, filters: [...visual.filters, ...filters] };
}

/** Explore une valeur du niveau courant (clic en mode exploration). Null au dernier niveau. */
export function drillDown(visual: Visual, value: Scalar): DrillState | null {
  const { level, path } = drillState(visual);
  if (level >= drillLevels(visual).length - 1) return null;
  return { level: level + 1, path: [...path, { value }] };
}

/** Niveau suivant pour tous les membres (sans filtrer). */
export function nextLevel(visual: Visual): DrillState | null {
  const { level, path } = drillState(visual);
  if (level >= drillLevels(visual).length - 1) return null;
  return { level: level + 1, path: [...path, null] };
}

/** Remonte d'un niveau. */
export function drillUp(visual: Visual): DrillState | null {
  const { level, path } = drillState(visual);
  if (level === 0) return null;
  return { level: level - 1, path: path.slice(0, level - 1) };
}

/** Fil d'Ariane : « region › Occitanie › departement ». */
export function drillCrumbs(visual: Visual, dataset: DatasetProfile | undefined): string[] {
  if (!canDrill(visual)) return [];
  const levels = drillLevels(visual);
  const { level, path } = drillState(visual);
  const typeOf = (b: FieldBinding) => dataset?.columns.find((c) => c.name === b.field)?.type;
  const crumbs: string[] = [];
  path.forEach((step, i) => {
    const b = levels[i];
    if (!b) return;
    crumbs.push(step ? formatDimension(step.value, typeOf(b), b.bin) : `${bindingLabel(b)} (tout)`);
  });
  const current = levels[level];
  if (current) crumbs.push(bindingLabel(current));
  return crumbs;
}

/** Hiérarchie de dates : un champ date devient année → trimestre → mois (→ jour). */
export function dateHierarchy(binding: FieldBinding, withDay = false): FieldBinding[] {
  const bins: DateBin[] = withDay ? ["year", "quarter", "month", "day"] : ["year", "quarter", "month"];
  return bins.map((bin) => ({ field: binding.field, bin }));
}
