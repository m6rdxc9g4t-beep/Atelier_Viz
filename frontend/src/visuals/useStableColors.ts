/**
 * Couleurs stables par valeur : la couleur suit l'entité, jamais son rang.
 *
 * Le domaine est calculé SANS filtres (toutes les valeurs du champ, classées par la mesure) :
 * filtrer « Logiciel » ne le fait pas passer de l'orange au bleu.
 */

import type { QueryRequest } from "../types/query";
import type { FieldBinding, Visual } from "../types/report";
import { MAX_SERIES, OTHER_COLOR, seriesColor, valueKey } from "./common";
import { bindingKey, dimension, measure } from "./fields";
import { type QueryResult, useQueryResult } from "./useQueryResult";

export type ColorMap = Map<string, string>;

/** Construit la table valeur → couleur à partir des valeurs classées (plus grande d'abord). */
export function colorDomain(keys: string[], cap = MAX_SERIES): ColorMap {
  const colored = keys.length > cap ? cap - 1 : cap;
  return new Map(keys.map((k, i) => [k, i < colored ? seriesColor(i) : OTHER_COLOR]));
}

/** Requête du domaine de couleurs : toutes les valeurs du champ, sans filtres, classées par la mesure. */
export function colorRequest(visual: Visual, field: FieldBinding | undefined, rankBy: FieldBinding | undefined): QueryRequest | null {
  if (!field || !visual.dataset_id) return null;
  const m = rankBy ? measure(rankBy) : { agg: "count" as const };
  const key = rankBy ? bindingKey(rankBy) : "count(*)";
  return {
    dataset_id: visual.dataset_id,
    dimensions: [dimension(field)],
    measures: [m],
    sort: [{ key, desc: true }],
    limit: 1000,
  };
}

/** Table valeur → couleur à partir du résultat de `colorRequest`. */
export function colorsFromResult(field: FieldBinding, result: QueryResult, cap = MAX_SERIES): ColorMap {
  return colorDomain(
    result.rows.map((r) => valueKey(r[bindingKey(field)] ?? null)),
    cap,
  );
}

export function useStableColors(
  visual: Visual,
  field: FieldBinding | undefined,
  rankBy: FieldBinding | undefined,
  cap = MAX_SERIES,
): ColorMap | null {
  const { result } = useQueryResult(colorRequest(visual, field, rankBy));
  if (!field || !result) return null;
  return colorsFromResult(field, result, cap);
}
