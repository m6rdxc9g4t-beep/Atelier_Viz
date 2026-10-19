import {
  Area,
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  LabelList,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { AXIS, Legend, TooltipBox, VisualMessage, dimmed, first, numberFormat, toggleSelection } from "../common";
import { formatNumber } from "../format";
import { opt, type VisualProps } from "../types";
import { useStableColors } from "../useStableColors";
import { type Datum, shapeSeries } from "./series";

type Kind = "bar" | "line" | "area";

/** Barres, colonnes, lignes, aires et combo — un seul axe de valeurs (jamais de double axe). */
export function CartesianVisual(props: VisualProps) {
  const { visual, def, result, dataset, selection, onSelect } = props;
  const isCombo = visual.type === "combo";
  const colors = useStableColors(visual, first(visual, "series"), first(visual, "values"));
  if (!result) return null;

  const horizontal = visual.type === "bar";
  const { data, series, category } = shapeSeries(visual, result, dataset, isCombo ? ["values", "lines"] : ["values"], colors);
  if (!data.length) return <VisualMessage>Aucune donnée pour ces filtres.</VisualMessage>;

  const fmt = numberFormat(visual);
  const stacked = opt<boolean>(visual, def, "stacked");
  const percent = opt<boolean>(visual, def, "percent");
  const showLabels = opt<boolean>(visual, def, "labels");
  const showLegend = opt<boolean>(visual, def, "legend");
  const smooth = opt<boolean>(visual, def, "smooth");
  const markers = opt<boolean>(visual, def, "markers");
  const stackId = stacked || percent ? "stack" : undefined;

  const kindOf = (role: string): Kind => {
    if (isCombo) return role === "lines" ? "line" : "bar";
    if (visual.type === "line") return "line";
    if (visual.type === "area") return "area";
    return "bar";
  };

  const valueTick = (v: number) => (percent ? `${Math.round(v * 100)} %` : formatNumber(v, { ...fmt, compact: true }));
  const select = (d: Datum | undefined) => d && category && toggleSelection(selection, visual, category, d.__cat, onSelect);

  const valueAxisProps = { ...AXIS, tickFormatter: valueTick, width: horizontal ? undefined : 56 };
  // Largeur de l'axe des catégories (barres horizontales) : selon le libellé le plus long, bornée.
  const catWidth = Math.min(180, Math.max(48, ...data.map((d) => d.__label.length * 6.2 + 8)));
  const catAxisProps = {
    ...AXIS,
    dataKey: "__label",
    // Recharts masque les étiquettes qui se chevauchent ; les longues sont abrégées (texte complet dans l'info-bulle).
    interval: "preserveStartEnd" as const,
    minTickGap: 6,
    tickFormatter: (v: string) => (!horizontal && v.length > 14 ? `${v.slice(0, 13)}…` : v),
  };

  return (
    <div className="flex h-full flex-col">
      {showLegend && <Legend items={series.map((s) => ({ label: s.label, color: s.color }))} />}
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={data}
            layout={horizontal ? "vertical" : "horizontal"}
            stackOffset={percent ? "expand" : undefined}
            margin={{ top: 8, right: horizontal && showLabels ? 44 : 12, bottom: 0, left: 0 }}
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
                <YAxis type="category" {...catAxisProps} width={catWidth} interval={0} />
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
                const entries = (p.payload ?? []) as readonly { dataKey?: unknown; value?: unknown; color?: string }[];
                if (!p.active || !entries.length) return null;
                return (
                  <TooltipBox
                    title={String(p.label ?? "")}
                    rows={entries.map((e) => {
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
                    className="fill-[var(--muted)] text-[10px]"
                    formatter={(v: unknown) => (percent ? "" : formatNumber(v as number, { ...fmt, compact: true }))}
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
                    {data.map((d) => (
                      <Cell key={String(d.__label)} opacity={dimmed(selection, visual, d.__cat) ? 0.3 : 1} />
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
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
