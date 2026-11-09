/**
 * Info-bulles enrichies : mesures du rôle « Info-bulles », une valeur exacte par élément de la
 * dimension du visuel (axe, légende d'un secteur, emplacement d'une carte), chargées à part.
 */

import { useMemo } from "react";

import type { Scalar } from "../types/dataset";
import { TOOLTIP_ROLE, first, numberFormat, role, tooltipQuery, valueKey } from "./common";
import { bindingKey, bindingLabel } from "./fields";
import { formatNumber } from "./format";
import { withParameters } from "./interactive/parameters";
import type { VisualProps } from "./types";
import { useQueryResult } from "./useQueryResult";

export interface TooltipExtra {
  label: string;
  value: string;
}

/**
 * Lignes d'info-bulle en plus pour un élément (`raw` = valeur de la dimension `dimRole`), ou [] —
 * élément « Autres », prévision ou visuel sans info-bulles.
 */
export function useTooltipExtras(props: Pick<VisualProps, "visual" | "filters" | "parameters" | "dataset">, dimRole = "category"): (raw: Scalar | undefined) => TooltipExtra[] {
  const { visual, filters, parameters, dataset } = props;
  const request = useMemo(
    () => withParameters(tooltipQuery(visual, filters, dimRole), parameters, dataset),
    [visual, filters, parameters, dataset, dimRole],
  );
  const result = useQueryResult(request).result;
  return useMemo(() => {
    const dim = first(visual, dimRole);
    const tips = role(visual, TOOLTIP_ROLE);
    const rows = new Map<string, Record<string, unknown>>();
    if (result && dim) for (const r of result.rows) rows.set(valueKey(r[bindingKey(dim)] ?? null), r);
    return (raw) => {
      if (raw === undefined || !tips.length) return [];
      const row = rows.get(valueKey(raw));
      if (!row) return [];
      return tips.map((b) => ({ label: bindingLabel(b), value: formatNumber((row[bindingKey(b)] ?? null) as number | null, numberFormat(visual, b)) }));
    };
  }, [result, visual, dimRole]);
}
