/** Chargement des données de chaque visuel exporté (mêmes requêtes et filtres qu'à l'écran). */

import { visualFilters } from "../studio/filters";
import type { DatasetProfile } from "../types/dataset";
import type { Filter, QueryRequest } from "../types/query";
import type { Page, Visual } from "../types/report";
import { first, isReady } from "../visuals/common";
import { drillView } from "../visuals/drill";
import { kpiTrendRequest } from "../visuals/data/KpiVisual";
import { VISUALS } from "../visuals/registry";
import type { Selection } from "../visuals/types";
import { colorRequest, colorsFromResult } from "../visuals/useStableColors";
import { type QueryResult, runQuery } from "../visuals/useQueryResult";
import type { VisualData } from "./buildVisual";

export interface LoadedVisual extends VisualData {
  filters: Filter[];
}

const CARTESIAN = new Set(["column", "bar", "line", "area", "combo"]);
const PARTS = new Set(["pie", "donut"]);

/** Requêtes d'un visuel : principale, domaine de couleurs, tendance KPI. */
export function visualRequests(
  page: Page,
  visual: Visual,
  selection: Selection | null,
  profiles: Map<string, DatasetProfile>,
): { filters: Filter[]; main: QueryRequest | null; colors: QueryRequest | null; trend: QueryRequest | null } {
  visual = drillView(visual); // niveau d'exploration affiché
  const def = VISUALS[visual.type];
  const filters = visualFilters(page, visual, selection, (id) => profiles.get(id));
  if (!def.query || !isReady(visual, def)) return { filters, main: null, colors: null, trend: null };
  const colorField = CARTESIAN.has(visual.type) ? first(visual, "series") : PARTS.has(visual.type) ? first(visual, "category") : undefined;
  return {
    filters,
    main: def.query(visual, filters),
    colors: colorField ? colorRequest(visual, colorField, first(visual, "values")) : null,
    trend: visual.type === "kpi" ? kpiTrendRequest(visual, filters) : null,
  };
}

const settle = async (req: QueryRequest | null): Promise<QueryResult | null> => (req ? runQuery(req) : null);

export async function loadVisual(
  page: Page,
  visual: Visual,
  selection: Selection | null,
  profiles: Map<string, DatasetProfile>,
): Promise<LoadedVisual> {
  visual = drillView(visual);
  const reqs = visualRequests(page, visual, selection, profiles);
  const [main, colors, trend] = await Promise.allSettled([settle(reqs.main), settle(reqs.colors), settle(reqs.trend)]);
  const colorField = CARTESIAN.has(visual.type) ? first(visual, "series") : first(visual, "category");
  return {
    filters: reqs.filters,
    result: main.status === "fulfilled" ? main.value : null,
    error: main.status === "rejected" ? (main.reason instanceof Error ? main.reason.message : String(main.reason)) : null,
    colors: colors.status === "fulfilled" && colors.value && colorField ? colorsFromResult(colorField, colors.value) : null,
    trend: trend.status === "fulfilled" ? trend.value : null,
  };
}

/** Exécute `fn` sur chaque élément avec au plus `limit` tâches simultanées. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
