/**
 * Contexte de filtres d'un visuel — dans l'ordre :
 * 1. filtres de la page (si le jeu de données du visuel possède le champ) ;
 * 2. segments de la page (même jeu de données, sauf le visuel lui-même) ;
 * 3. sélection par clic dans un autre visuel (filtrage croisé, même jeu de données) ;
 * 4. filtres propres au visuel.
 *
 * Relations : un segment ou une sélection posé sur un jeu lié (côté « un ») filtre aussi ce jeu, par
 * sa colonne liée `<relation>.<champ>` (sens unique, comme dans Power BI ; chaînes comprises).
 */

import type { DatasetProfile, Scalar } from "../types/dataset";
import type { Filter } from "../types/query";
import type { Page, Visual } from "../types/report";
import { first } from "../visuals/common";
import type { Selection } from "../visuals/types";

export function slicerFilter(v: Visual): Filter | null {
  if (v.type !== "slicer") return null;
  const field = first(v, "field");
  if (!field) return null;
  if ((v.options.style ?? "list") === "range") {
    const range = (v.options.range as [Scalar, Scalar] | undefined) ?? [null, null];
    if (range[0] === null && range[1] === null) return null;
    return { field: field.field, op: "between", values: [range[0] ?? null, range[1] ?? null] };
  }
  const selected = (v.options.selected as Scalar[] | undefined) ?? [];
  return selected.length ? { field: field.field, op: "in", values: selected, bin: field.bin ?? null } : null;
}

/**
 * Préfixe des colonnes d'un jeu `source` vues depuis le jeu `target` (« regions. », « regions.geo. »),
 * en suivant les relations ; "" pour le même jeu, null si aucun chemin.
 */
export function relatedPrefix(
  target: string | null | undefined,
  source: string | null | undefined,
  profileOf: (id: string) => DatasetProfile | undefined,
  depth = 0,
): string | null {
  if (!target || !source) return null;
  if (target === source) return "";
  if (depth > 4) return null;
  for (const rel of profileOf(target)?.model?.relations ?? []) {
    const rest = relatedPrefix(rel.dataset_id, source, profileOf, depth + 1);
    if (rest !== null) return `${rel.name}.${rest}`;
  }
  return null;
}

export function visualFilters(
  page: Page,
  visual: Visual,
  selection: Selection | null,
  profileOf: (datasetId: string) => DatasetProfile | undefined,
  extraction: { datasetId: string; filters: Filter[] } | null = null,
): Filter[] {
  const profile = visual.dataset_id ? profileOf(visual.dataset_id) : undefined;
  const fields = profile ? new Set(profile.columns.map((c) => c.name)) : undefined;
  const pageFilters = page.filters.filter((f) => fields?.has(f.field));
  // Filtre d'un autre jeu : repris s'il est lié à ce jeu et que la colonne liée existe.
  const adapt = (f: Filter, from: string | null | undefined): Filter | null => {
    const prefix = relatedPrefix(visual.dataset_id, from, profileOf);
    if (prefix === null) return null;
    if (prefix === "") return f;
    const field = `${prefix}${f.field}`;
    return fields?.has(field) ? { ...f, field } : null;
  };
  const slicers = page.visuals
    .filter((o) => o.type === "slicer" && o.id !== visual.id)
    .map((o) => {
      const f = slicerFilter(o);
      return f ? adapt(f, o.dataset_id) : null;
    })
    .filter((f): f is Filter => f !== null);
  const cross =
    selection && selection.visualId !== visual.id
      ? selection.filters.map((f) => adapt(f, selection.datasetId)).filter((f): f is Filter => f !== null)
      : [];
  // Extraction : par la relation, sinon par une colonne de même nom dans ce jeu.
  const drilled = (extraction?.filters ?? [])
    .map((f) => adapt(f, extraction?.datasetId) ?? (fields?.has(f.field) ? f : null))
    .filter((f): f is Filter => f !== null);
  return [...pageFilters, ...drilled, ...slicers, ...cross, ...visual.filters];
}

/** Tous les filtres actifs de la page (utilisés par les gabarits des boutons). */
export function pageActiveFilters(page: Page, selection: Selection | null): Filter[] {
  const slicers = page.visuals.map(slicerFilter).filter((f): f is Filter => f !== null);
  return [...page.filters, ...slicers, ...(selection?.filters ?? [])];
}
