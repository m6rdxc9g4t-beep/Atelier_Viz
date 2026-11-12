import clsx from "clsx";
import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer } from "recharts";

import { first, numberFormat } from "../common";
import { bindingKey, bindingLabel, dimension, measure } from "../fields";
import { formatNumber } from "../format";
import { opt, type VisualProps } from "../types";
import type { Filter, QueryRequest } from "../../types/query";
import type { Visual } from "../../types/report";
import { withParameters } from "../interactive/parameters";
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

/**
 * Taille de la valeur (px) : 8 % de la largeur de la carte, jamais sous 24 px tant que la hauteur le permet
 * (une carte étroite du gabarit garde un chiffre nettement plus grand que son titre), bornée par 44 % de la
 * hauteur pour que la ligne tienne entière au-dessus de l'écart à la cible ou de la mini-tendance.
 */
export const KPI_VALUE = { min: 18, floor: 24, widthShare: 8, heightShare: 44, max: 52 } as const;

/** La même règle en CSS (unités de conteneur : la carte est un conteneur `size`). */
export const KPI_VALUE_SIZE = `clamp(${KPI_VALUE.min / 16}rem, min(max(${KPI_VALUE.widthShare}cqw, ${KPI_VALUE.floor / 16}rem), ${KPI_VALUE.heightShare}cqh), ${KPI_VALUE.max / 16}rem)`;

/** Taille de la valeur pour une carte dont le contenu fait `width` × `height` px (miroir de `KPI_VALUE_SIZE`). */
export function kpiValueSize(width: number, height: number): number {
  const wanted = Math.max((width * KPI_VALUE.widthShare) / 100, KPI_VALUE.floor);
  return Math.min(KPI_VALUE.max, Math.max(KPI_VALUE.min, Math.min(wanted, (height * KPI_VALUE.heightShare) / 100)));
}

/** Carte KPI : valeur héroïque, écart à la cible, mini-tendance optionnelle. */
export function KpiVisual(props: VisualProps) {
  const { visual, def, result, filters } = props;
  const valueB = first(visual, "values");
  const targetB = first(visual, "target");

  const trend = useQueryResult(withParameters(kpiTrendRequest(visual, filters), props.parameters, props.dataset));

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

  const text = formatNumber(value, fmt);

  // La valeur passe avant tout : elle ne rétrécit jamais (taille bornée par la largeur ET la hauteur de la
  // carte) ; la mini-tendance prend la place qui reste et disparaît quand il n'y en a plus assez.
  return (
    <div className="flex h-full flex-col justify-center gap-1 overflow-hidden px-1 [container-type:size]">
      {!visual.title && <p className="shrink-0 truncate text-xs text-muted">{bindingLabel(valueB)}</p>}
      <p
        data-kpi-value
        title={text}
        className="shrink-0 truncate font-semibold leading-tight tracking-tight tabular-nums"
        style={{ fontSize: KPI_VALUE_SIZE }}
      >
        {text}
      </p>
      {gap !== null && target !== null && (
        <p className={clsx("flex shrink-0 items-center gap-1 text-xs", good ? "text-positive" : "text-negative")}>
          <Arrow className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">
            {gap >= 0 ? "+" : ""}
            {gap.toFixed(1).replace(".", ",")} %{" "}
            <span className="text-muted">vs cible ({formatNumber(target, { ...fmt, compact: true })})</span>
          </span>
        </p>
      )}
      {spark.length > 1 && (
        <div data-kpi-trend className="min-h-0 w-full shrink basis-10 [container-type:size]">
          <div className="hidden h-full [@container_(min-height:18px)]:block">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={spark} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
                <Area dataKey="v" stroke="var(--series-1)" strokeWidth={2} fill="var(--series-1)" fillOpacity={0.12} dot={false} isAnimationActive={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
