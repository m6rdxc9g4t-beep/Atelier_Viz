import {
  Area,
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  LabelList,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { AXIS, Legend, TooltipBox, VisualMessage, dimmed, first, numberFormat, toggleSelection } from "../common";
import { categoryAxis, lastTickMargin, truncateEnd, valueLabelMargin, AXIS_FONT } from "../fit";
import { formatNumber } from "../format";
import { useTooltipExtras } from "../tooltips";
import { opt, type VisualProps } from "../types";
import { useStableColors } from "../useStableColors";
import { columnType, shapeSeries } from "./series";
import { type TrendDatum, trendApplies, withTrend } from "./trend";

type Kind = "bar" | "line" | "area";

/** Barres, colonnes, lignes, aires et combo — un seul axe de valeurs (jamais de double axe). */
export function CartesianVisual(props: VisualProps) {
  const { visual, def, result, dataset, selection, onSelect } = props;
  const isCombo = visual.type === "combo";
  const colors = useStableColors(visual, first(visual, "series"), first(visual, "values"));
  // Info-bulles : mesures en plus, une valeur par élément de l'axe (requête à part).
  const tooltipExtras = useTooltipExtras(props);
  if (!result) return null;

  const horizontal = visual.type === "bar";
  const { data: shaped, series, category } = shapeSeries(visual, result, dataset, isCombo ? ["values", "lines"] : ["values"], colors);
  if (!shaped.length) return <VisualMessage>Aucune donnée pour ces filtres.</VisualMessage>;

  const fmt = numberFormat(visual);
  const stacked = opt<boolean>(visual, def, "stacked");
  const percent = opt<boolean>(visual, def, "percent");
  const showLabels = opt<boolean>(visual, def, "labels");
  const showLegend = opt<boolean>(visual, def, "legend");
  const smooth = opt<boolean>(visual, def, "smooth");
  const markers = opt<boolean>(visual, def, "markers");
  const stackId = stacked || percent ? "stack" : undefined;

  // Analyse : tendance linéaire et prévision (calcul local, jamais envoyé comme donnée).
  const analysis =
    !horizontal && !isCombo && !!category && trendApplies({ sort: opt<string>(visual, def, "sort"), stacked, percent })
      ? withTrend(shaped, series, {
          trend: opt<boolean>(visual, def, "trend") === true,
          forecast: Number(opt<number>(visual, def, "forecast") ?? 0) || 0,
          seasonal: opt<boolean>(visual, def, "seasonal") === true,
          catType: columnType(dataset, category.field),
          bin: category.bin,
        })
      : null;
  const data: TrendDatum[] = analysis?.data ?? shaped;
  const derived = analysis?.derived ?? [];
  const lastActual = shaped[shaped.length - 1]?.__label;

  const kindOf = (role: string): Kind => {
    if (isCombo) return role === "lines" ? "line" : "bar";
    if (visual.type === "line") return "line";
    if (visual.type === "area") return "area";
    return "bar";
  };

  const valueTick = (v: number) => (percent ? `${Math.round(v * 100)} %` : formatNumber(v, { ...fmt, compact: true }));
  const select = (d: TrendDatum | undefined) => d && !d.__forecast && category && toggleSelection(selection, visual, category, d.__cat, onSelect);

  const valueAxisProps = { ...AXIS, tickFormatter: valueTick, width: horizontal ? undefined : 56 };
  // Axe des catégories des barres horizontales : large comme son libellé le plus long (borné), le reste abrégé par la fin.
  const catAxis = categoryAxis(data.map((d) => d.__label));
  const catTick = (v: string) => (horizontal ? catAxis.format(v) : truncateEnd(v, 84, AXIS_FONT));
  const catAxisProps = {
    ...AXIS,
    dataKey: "__label",
    // Recharts masque les étiquettes qui se chevauchent ; les longues sont abrégées (texte complet dans l'info-bulle).
    interval: "preserveStartEnd" as const,
    minTickGap: 6,
    tickFormatter: catTick,
  };
  const valueLabel = (v: unknown) => (percent || v === null || v === undefined ? "" : formatNumber(v as number, { ...fmt, compact: true }));
  // Marge droite : la place des étiquettes de valeur (barres horizontales) ou de la moitié de la dernière
  // graduation quand le dernier point est au bord du tracé (lignes, aires : pas de bande autour du point).
  const hasBars = [...series.map((s) => kindOf(s.role))].includes("bar");
  const marginRight = horizontal
    ? showLabels
      ? valueLabelMargin(stackId ? [] : data.flatMap((d) => series.map((s) => valueLabel(d[s.key]))), 44)
      : 12
    : hasBars
      ? 12
      : lastTickMargin(catTick(data[data.length - 1]?.__label ?? ""));

  return (
    <div className="flex h-full flex-col">
      {showLegend && <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />}
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={data}
            layout={horizontal ? "vertical" : "horizontal"}
            stackOffset={percent ? "expand" : undefined}
            margin={{ top: 8, right: marginRight, bottom: 0, left: 0 }}
            barCategoryGap="20%"
            barGap={2}
            onClick={(state) => {
              // Clic n'importe où dans la bande d'une catégorie (barre, point, aire) → filtrage croisé.
              const index = Number(state?.activeTooltipIndex);
              if (Number.isFinite(index)) select(data[index]);
            }}
          >
            <CartesianGrid stroke="var(--grid)" vertical={horizontal} horizontal={!horizontal} />
            {horizontal ? (
              <>
                <XAxis type="number" {...valueAxisProps} />
                <YAxis type="category" {...catAxisProps} width={catAxis.width} interval={0} />
              </>
            ) : (
              <>
                <XAxis {...catAxisProps} />
                <YAxis {...valueAxisProps} />
              </>
            )}
            <Tooltip
              cursor={{ fill: "var(--surface-2)", stroke: "var(--grid)" }}
              content={(p) => {
                const all = (p.payload ?? []) as readonly { dataKey?: unknown; value?: unknown; color?: string; payload?: TrendDatum }[];
                const future = all[0]?.payload?.__forecast === true;
                const entries = all.filter((e) => {
                  if (e.value === null || e.value === undefined) return false;
                  const d = derived.find((x) => x.key === e.dataKey);
                  // Prévision et intervalle : seulement sur les périodes prévues (au raccord, la valeur réelle suffit).
                  return !d || d.kind === "trend" || future;
                });
                if (!p.active || !entries.length) return null;
                const datum = all[0]?.payload;
                const extra = datum && !future ? tooltipExtras(datum.__cat) : [];
                return (
                  <TooltipBox
                    title={future ? `${String(p.label ?? "")} (prévision)` : String(p.label ?? "")}
                    extra={extra}
                    rows={entries.map((e) => {
                      const d = derived.find((x) => x.key === e.dataKey);
                      if (d) {
                        const label = d.kind === "trend" ? `Tendance · ${d.source.label}` : d.kind === "forecast" ? `Prévision · ${d.source.label}` : `Intervalle 95 % · ${d.source.label}`;
                        const value = Array.isArray(e.value)
                          ? `${formatNumber(e.value[0] as number, fmt)} – ${formatNumber(e.value[1] as number, fmt)}`
                          : formatNumber(e.value as number, fmt);
                        return { label, color: d.source.color, value };
                      }
                      const s = series.find((x) => x.key === e.dataKey);
                      return { label: s?.label ?? String(e.dataKey), color: s?.color, value: formatNumber(e.value as number, fmt) };
                    })}
                  />
                );
              }}
            />
            {series.map((s, i) => {
              const kind = kindOf(s.role);
              const isLast = i === series.length - 1;
              const label =
                showLabels && (!stackId || isLast) ? (
                  <LabelList
                    dataKey={s.key}
                    position={horizontal ? "right" : "top"}
                    // Taille en attribut SVG (pas en classe) : l'export image / PDF la garde, les étiquettes ne grossissent pas.
                    fontSize={10}
                    className="fill-[var(--muted)]"
                    formatter={valueLabel}
                  />
                ) : null;
              if (kind === "bar") {
                return (
                  <Bar
                    key={s.key}
                    dataKey={s.key}
                    name={s.label}
                    fill={s.color}
                    stackId={stackId}
                    maxBarSize={24}
                    radius={stackId && !isLast ? 0 : horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0]}
                    stroke="var(--surface)"
                    strokeWidth={stackId ? 1 : 0}
                    isAnimationActive={false}
                    cursor="pointer"
                  >
                    {data.map((d, i) => (
                      <Cell key={`${String(d.__label)}-${i}`} opacity={dimmed(selection, visual, d.__cat) ? 0.3 : 1} />
                    ))}
                    {label}
                  </Bar>
                );
              }
              if (kind === "area") {
                return (
                  <Area
                    key={s.key}
                    dataKey={s.key}
                    name={s.label}
                    type={smooth ? "monotone" : "linear"}
                    stroke={s.color}
                    strokeWidth={2}
                    fill={s.color}
                    fillOpacity={stackId ? 0.85 : 0.15}
                    stackId={stackId}
                    dot={false}
                    activeDot={{ r: 4, stroke: "var(--surface)", strokeWidth: 2 }}
                    isAnimationActive={false}
                  >
                    {label}
                  </Area>
                );
              }
              return (
                <Line
                  key={s.key}
                  dataKey={s.key}
                  name={s.label}
                  type={smooth ? "monotone" : "linear"}
                  stroke={s.color}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  dot={markers ? { r: 4, fill: s.color, stroke: "var(--surface)", strokeWidth: 2 } : false}
                  activeDot={{ r: 5, stroke: "var(--surface)", strokeWidth: 2 }}
                  connectNulls
                  isAnimationActive={false}
                >
                  {label}
                </Line>
              );
            })}
            {analysis?.forecastStart && lastActual && <ReferenceLine x={lastActual} stroke="var(--muted)" strokeDasharray="2 3" ifOverflow="extendDomain" />}
            {derived.map((d) => {
              if (d.kind === "band") {
                return (
                  <Area
                    key={d.key}
                    dataKey={d.key}
                    name={`Intervalle 95 % · ${d.source.label}`}
                    type="linear"
                    stroke="none"
                    fill={d.source.color}
                    fillOpacity={0.14}
                    dot={false}
                    activeDot={false}
                    legendType="none"
                    isAnimationActive={false}
                  />
                );
              }
              return (
                <Line
                  key={d.key}
                  dataKey={d.key}
                  name={`${d.kind === "trend" ? "Tendance" : "Prévision"} · ${d.source.label}`}
                  type="linear"
                  stroke={d.source.color}
                  strokeWidth={d.kind === "trend" ? 1.5 : 2}
                  strokeDasharray={d.kind === "trend" ? "2 4" : "6 4"}
                  strokeOpacity={d.kind === "trend" ? 0.85 : 1}
                  dot={d.kind === "forecast" ? { r: 2.5, fill: d.source.color, stroke: "var(--surface)", strokeWidth: 1 } : false}
                  activeDot={d.kind === "forecast" ? { r: 4, stroke: "var(--surface)", strokeWidth: 2 } : false}
                  legendType="none"
                  connectNulls={false}
                  isAnimationActive={false}
                />
              );
            })}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {derived.length > 0 && <AnalysisCaption derived={derived} />}
    </div>
  );
}

/** Légende des tracés d'analyse (pointillés), avec le R² de chaque droite. */
function AnalysisCaption({ derived }: { derived: { kind: string; r2: number; seasonal?: boolean; source: { label: string } }[] }) {
  const trend = derived.filter((d) => d.kind === "trend");
  const forecast = derived.some((d) => d.kind === "forecast");
  const seasonal = derived.some((d) => d.kind === "forecast" && d.seasonal);
  const r2 = trend.length === 1 && trend[0] ? ` (R² ${trend[0].r2.toLocaleString("fr-FR", { maximumFractionDigits: 2 })})` : "";
  return (
    <p className="mt-1 flex flex-wrap gap-x-3 text-[10px] leading-4 text-[var(--muted)]">
      {trend.length > 0 && (
        <span className="inline-flex items-center gap-1">
          <svg width="18" height="4" aria-hidden>
            <line x1="0" y1="2" x2="18" y2="2" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 4" />
          </svg>
          Tendance linéaire{r2}
        </span>
      )}
      {forecast && (
        <span className="inline-flex items-center gap-1">
          <svg width="18" height="4" aria-hidden>
            <line x1="0" y1="2" x2="18" y2="2" stroke="currentColor" strokeWidth="2" strokeDasharray="6 4" />
          </svg>
          {seasonal ? "Prévision tendance + saisons" : "Prévision linéaire"}, zone = intervalle à 95 %
        </span>
      )}
    </p>
  );
}
