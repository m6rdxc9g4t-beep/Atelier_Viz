/**
 * Contexte de filtres d'un visuel — dans l'ordre :
 * 1. filtres de la page (si le jeu de données du visuel possède le champ) ;
 * 2. segments de la page (même jeu de données, sauf le visuel lui-même) ;
 * 3. sélection par clic dans un autre visuel (filtrage croisé, même jeu de données) ;
 * 4. filtres propres au visuel.
 */

import type { Scalar } from "../types/dataset";
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

export function visualFilters(
  page: Page,
  visual: Visual,
  selection: Selection | null,
  fieldsOf: (datasetId: string | null | undefined) => Set<string> | undefined,
): Filter[] {
  const fields = fieldsOf(visual.dataset_id);
  const pageFilters = page.filters.filter((f) => fields?.has(f.field));
  const slicers = page.visuals
    .filter((o) => o.type === "slicer" && o.id !== visual.id && o.dataset_id === visual.dataset_id)
    .map(slicerFilter)
    .filter((f): f is Filter => f !== null);
  const cross =
    selection && selection.visualId !== visual.id && selection.datasetId === visual.dataset_id ? selection.filters : [];
  return [...pageFilters, ...slicers, ...cross, ...visual.filters];
}

/** Tous les filtres actifs de la page (utilisés par les gabarits des boutons). */
export function pageActiveFilters(page: Page, selection: Selection | null): Filter[] {
  const slicers = page.visuals.map(slicerFilter).filter((f): f is Filter => f !== null);
  return [...page.filters, ...slicers, ...(selection?.filters ?? [])];
}
