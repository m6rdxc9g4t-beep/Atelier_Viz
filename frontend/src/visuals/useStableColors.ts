/**
 * Couleurs stables par valeur : la couleur suit l'entité, jamais son rang.
 *
 * Le domaine est calculé SANS filtres (toutes les valeurs du champ, classées par la mesure) :
 * filtrer « Logiciel » ne le fait pas passer de l'orange au bleu.
 */

import type { FieldBinding, Visual } from "../types/report";
import { MAX_SERIES, OTHER_COLOR, seriesColor, valueKey } from "./common";
import { bindingKey, dimension, measure } from "./fields";
import { useQueryResult } from "./useQueryResult";

export type ColorMap = Map<string, string>;

/** Construit la table valeur → couleur à partir des valeurs classées (plus grande d'abord). */
export function colorDomain(keys: string[], cap = MAX_SERIES): ColorMap {
  const colored = keys.length > cap ? cap - 1 : cap;
  return new Map(keys.map((k, i) => [k, i < colored ? seriesColor(i) : OTHER_COLOR]));
}

export function useStableColors(
  visual: Visual,
  field: FieldBinding | undefined,
  rankBy: FieldBinding | undefined,
  cap = MAX_SERIES,
): ColorMap | null {
  const m = rankBy ? measure(rankBy) : { agg: "count" as const };
  const key = rankBy ? bindingKey(rankBy) : "count(*)";
  const { result } = useQueryResult(
    field && visual.dataset_id
      ? {
          dataset_id: visual.dataset_id,
          dimensions: [dimension(field)],
          measures: [m],
          sort: [{ key, desc: true }],
          limit: 1000,
        }
      : null,
  );
  if (!field || !result) return null;
  return colorDomain(
    result.rows.map((r) => valueKey(r[bindingKey(field)] ?? null)),
    cap,
  );
}
