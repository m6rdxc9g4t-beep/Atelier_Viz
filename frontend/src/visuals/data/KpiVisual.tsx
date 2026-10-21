import clsx from "clsx";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer } from "recharts";

import { first, numberFormat } from "../common";
import { bindingKey, bindingLabel, dimension, measure } from "../fields";
import { formatNumber } from "../format";
import { opt, type VisualProps } from "../types";
import type { Filter, QueryRequest } from "../../types/query";
import type { Visual } from "../../types/report";
import { useQueryResult } from "../useQueryResult";

/** Requête de la mini-tendance (valeur par date), ou null sans champ « Tendance ». */
export function kpiTrendRequest(visual: Visual, filters: Filter[]): QueryRequest | null {
  const valueB = first(visual, "values");
  const trendB = first(visual, "trend");
  if (!valueB || !trendB || !visual.dataset_id) return null;
  return { dataset_id: visual.dataset_id, dimensions: [dimension(trendB)], measures: [measure(valueB)], filters, limit: 500 };
}

/** Écart à la cible en % (null sans cible). */
export function kpiGap(value: number, target: number | null): number | null {
  return target ? ((value - target) / Math.abs(target)) * 100 : null;
}

/** Carte KPI : valeur héroïque, écart à la cible, mini-tendance optionnelle. */
export function KpiVisual(props: VisualProps) {
  const { visual, def, result, filters } = props;
  const valueB = first(visual, "values");
  const targetB = first(visual, "target");

  const trend = useQueryResult(kpiTrendRequest(visual, filters));

  const row = result?.rows[0];
  if (!valueB || !row) return null;
  const fmt = numberFormat(visual, valueB);
  const value = Number(row[bindingKey(valueB)] ?? 0);
  const target = targetB ? Number(row[bindingKey(targetB)] ?? 0) : null;
  const gap = kpiGap(value, target);
  const higherIsBetter = opt<boolean>(visual, def, "higherIsBetter");
  const good = gap === null ? null : higherIsBetter ? gap >= 0 : gap <= 0;
  const Arrow = gap !== null && gap >= 0 ? ArrowUpRight : ArrowDownRight;
  const spark = trend.result?.rows.map((r) => ({ v: Number(r[bindingKey(valueB)] ?? 0) })) ?? [];

  return (
    <div className="flex h-full flex-col justify-center gap-1 px-1 @container">
      {!visual.title && <p className="truncate text-xs text-muted">{bindingLabel(valueB)}</p>}
      <p className="truncate text-[clamp(1.5rem,8cqw,3.25rem)] font-semibold leading-tight tracking-tight tabular-nums">
        {formatNumber(value, fmt)}
      </p>
      {gap !== null && target !== null && (
        <p className={clsx("flex items-center gap-1 text-xs", good ? "text-positive" : "text-negative")}>
          <Arrow className="size-3.5 shrink-0" aria-hidden />
          <span>
            {gap >= 0 ? "+" : ""}
            {gap.toFixed(1).replace(".", ",")} %{" "}
            <span className="text-muted">vs cible ({formatNumber(target, { ...fmt, compact: true })})</span>
          </span>
        </p>
      )}
      {spark.length > 1 && (
        <div className="h-10 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={spark} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
              <Area dataKey="v" stroke="var(--series-1)" strokeWidth={2} fill="var(--series-1)" fillOpacity={0.12} dot={false} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
