/** Visuels « part d'un tout » et classements : secteurs/anneau, treemap, entonnoir, radar, cascade. */

import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Funnel,
  FunnelChart,
  LabelList,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
  Treemap,
  XAxis,
  YAxis,
} from "recharts";

import type { Scalar } from "../../types/dataset";
import {
  AXIS,
  Legend,
  MAX_SERIES,
  OTHER_COLOR,
  TooltipBox,
  VisualMessage,
  dimmed,
  first,
  numberFormat,
  role,
  seriesColor,
  toggleSelection,
  valueKey,
} from "../common";
import { bindingKey, bindingLabel } from "../fields";
import { formatDimension, formatNumber } from "../format";
import { opt, type VisualProps } from "../types";
import { type ColorMap, colorDomain, useStableColors } from "../useStableColors";
import { columnType } from "./series";

interface Slice {
  value: number;
  label: string;
  raw: Scalar;
  color: string;
  other?: boolean;
}

/** Catégorie + 1 mesure → parts triées, 8 max (les suivantes regroupées en « Autres »). Couleurs stables par valeur. */
function slices(props: VisualProps, fold = true, colors: ColorMap | null = null): Slice[] {
  const { visual, result, dataset } = props;
  const cat = first(visual, "category");
  const m = first(visual, "values");
  if (!result || !cat || !m) return [];
  const type = columnType(dataset, cat.field);
  const items = result.rows
    .map((r) => ({ raw: r[bindingKey(cat)] ?? null, value: Number(r[bindingKey(m)] ?? 0) }))
    .filter((s) => Number.isFinite(s.value))
    .sort((a, b) => b.value - a.value);
  const domain = colors ?? colorDomain(items.map((s) => valueKey(s.raw)));
  const colorOf = (raw: Scalar) => domain.get(valueKey(raw)) ?? OTHER_COLOR;
  const keep = fold ? items.filter((s) => colorOf(s.raw) !== OTHER_COLOR) : items;
  const out: Slice[] = keep.map((s, i) => ({
    ...s,
    label: formatDimension(s.raw, type, cat.bin),
    // Sans regroupement (treemap) : au-delà des 8 couleurs, rampe séquentielle.
    color: fold || i < MAX_SERIES ? (colorOf(s.raw) === OTHER_COLOR ? "var(--seq-300)" : colorOf(s.raw)) : "var(--seq-300)",
  }));
  if (keep.length < items.length) {
    const rest = items.slice(keep.length).reduce((t, s) => t + s.value, 0);
    out.push({ value: rest, label: "Autres", raw: null, color: OTHER_COLOR, other: true });
  }
  return out;
}

interface SliceLabelProps {
  cx?: number;
  cy?: number;
  midAngle?: number;
  innerRadius?: number;
  outerRadius?: number;
  percent?: number;
  fill?: string;
}

/** Pourcentage dans la part (jamais hors du cadre) ; masqué sous 5 %. */
function SliceLabel({ cx = 0, cy = 0, midAngle = 0, innerRadius = 0, outerRadius = 0, percent = 0 }: SliceLabelProps) {
  if (percent < 0.05) return null;
  const r = innerRadius + (outerRadius - innerRadius) * (innerRadius ? 0.5 : 0.62);
  const a = (-midAngle * Math.PI) / 180;
  return (
    <text x={cx + r * Math.cos(a)} y={cy + r * Math.sin(a)} textAnchor="middle" dominantBaseline="central" fontSize={11} fontWeight={600} {...HALO}>
      {Math.round(percent * 100)} %
    </text>
  );
}

export function PieVisual(props: VisualProps) {
  const { visual, def, selection, onSelect } = props;
  const colors = useStableColors(visual, first(visual, "category"), first(visual, "values"));
  const data = slices(props, true, colors);
  if (!data.length) return <VisualMessage>Aucune donnée pour ces filtres.</VisualMessage>;
  const fmt = numberFormat(visual);
  const total = data.reduce((t, s) => t + s.value, 0);
  const donut = visual.type === "donut";
  const cat = first(visual, "category");
  const showLabels = opt<boolean>(visual, def, "labels");

  return (
    <div className="flex h-full flex-col">
      {opt<boolean>(visual, def, "legend") && <Legend items={data.map((s) => ({ label: s.label, color: s.color }))} />}
      <div className="relative min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="label"
              innerRadius={donut ? "58%" : 0}
              outerRadius="85%"
              paddingAngle={data.length > 1 ? 1 : 0}
              stroke="var(--surface)"
              strokeWidth={data.length > 1 ? 2 : 0}
              isAnimationActive={false}
              label={showLabels ? (p: SliceLabelProps) => <SliceLabel {...p} /> : false}
              labelLine={false}
              onClick={(_: unknown, i: number) => {
                const s = data[i];
                if (s && !s.other && cat) toggleSelection(selection, visual, cat, s.raw, onSelect);
              }}
              cursor="pointer"
            >
              {data.map((s) => (
                <Cell key={s.label} fill={s.color} opacity={!s.other && dimmed(selection, visual, s.raw) ? 0.3 : 1} />
              ))}
            </Pie>
            <Tooltip
              content={(p) => {
                const e = p.payload?.[0] as { payload?: Slice } | undefined;
                if (!p.active || !e?.payload) return null;
                const s = e.payload;
                return (
                  <TooltipBox
                    title={s.label}
                    rows={[
                      { label: "Valeur", value: formatNumber(s.value, fmt) },
                      { label: "Part", value: `${((s.value / total) * 100).toFixed(1).replace(".", ",")} %` },
                    ]}
                  />
                );
              }}
            />
          </PieChart>
        </ResponsiveContainer>
        {donut && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-lg font-semibold tabular-nums">{formatNumber(total, { ...fmt, compact: true })}</span>
            <span className="text-[10px] text-muted">Total</span>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Étiquette lisible sur n'importe quel aplat (y compris des couleurs personnalisées en hexadécimal) :
 * texte blanc avec un halo sombre.
 */
const HALO = { fill: "#ffffff", stroke: "rgba(0,0,0,0.45)", strokeWidth: 2.5, paintOrder: "stroke" as const, strokeLinejoin: "round" as const };

export function TreemapVisual(props: VisualProps) {
  const { visual, selection, onSelect } = props;
  const colors = useStableColors(visual, first(visual, "category"), first(visual, "values"));
  // Au-delà de 8 rectangles, la couleur n'identifie plus : rampe séquentielle (voir slices).
  const data = slices(props, false, colors).map((s) => ({ ...s, name: s.label }));
  if (!data.length) return <VisualMessage>Aucune donnée pour ces filtres.</VisualMessage>;
  const fmt = numberFormat(visual);
  const cat = first(visual, "category");

  return (
    <ResponsiveContainer width="100%" height="100%">
      <Treemap
        data={data}
        dataKey="value"
        nameKey="name"
        isAnimationActive={false}
        onClick={(node: unknown) => {
          const raw = (node as { raw?: Scalar }).raw;
          if (cat && raw !== undefined) toggleSelection(selection, visual, cat, raw, onSelect);
        }}
        content={(node: unknown) => {
          const n = node as { x: number; y: number; width: number; height: number; name?: string; value?: number; color?: string; raw?: Scalar; depth: number };
          if (n.depth === 0) return <g />;
          const show = n.width > 56 && n.height > 30;
          return (
            <g style={{ cursor: "pointer" }} opacity={dimmed(selection, visual, n.raw ?? null) ? 0.3 : 1}>
              <rect x={n.x} y={n.y} width={n.width} height={n.height} rx={4} fill={n.color} stroke="var(--surface)" strokeWidth={2} />
              {show && (
                <>
                  <text x={n.x + 8} y={n.y + 16} fontSize={11} fontWeight={600} {...HALO}>
                    {String(n.name).slice(0, Math.floor(n.width / 7))}
                  </text>
                  <text x={n.x + 8} y={n.y + 30} fontSize={10} {...HALO}>
                    {formatNumber(n.value ?? 0, { ...fmt, compact: true })}
                  </text>
                </>
              )}
            </g>
          );
        }}
      >
        <Tooltip
          content={(p) => {
            const s = (p.payload?.[0] as { payload?: Slice } | undefined)?.payload;
            if (!p.active || !s) return null;
            return <TooltipBox title={s.label} rows={[{ label: "Valeur", value: formatNumber(s.value, fmt) }]} />;
          }}
        />
      </Treemap>
    </ResponsiveContainer>
  );
}

export function FunnelVisual(props: VisualProps) {
  const { visual } = props;
  const ramp = ["--seq-700", "--seq-600", "--seq-500", "--seq-400", "--seq-300"];
  const data = slices(props, false).map((s, i) => ({ ...s, name: s.label, fill: `var(${ramp[Math.min(i, ramp.length - 1)]})` }));
  if (!data.length) return <VisualMessage>Aucune donnée pour ces filtres.</VisualMessage>;
  const fmt = numberFormat(visual);
  const top = data[0]?.value || 1;
  return (
    <ResponsiveContainer width="100%" height="100%">
      <FunnelChart margin={{ top: 4, right: 110, bottom: 4, left: 8 }}>
        <Tooltip
          content={(p) => {
            const s = (p.payload?.[0] as { payload?: Slice } | undefined)?.payload;
            if (!p.active || !s) return null;
            return (
              <TooltipBox
                title={s.label}
                rows={[
                  { label: "Valeur", value: formatNumber(s.value, fmt) },
                  { label: "% de la 1re étape", value: `${Math.round((s.value / top) * 100)} %` },
                ]}
              />
            );
          }}
        />
        <Funnel dataKey="value" data={data} isAnimationActive={false} stroke="var(--surface)" strokeWidth={2}>
          <LabelList
            position="right"
            dataKey="name"
            className="fill-[var(--fg)] text-[11px]"
            stroke="none"
          />
        </Funnel>
      </FunnelChart>
    </ResponsiveContainer>
  );
}

export function RadarVisual(props: VisualProps) {
  const { visual, result, dataset } = props;
  const cat = first(visual, "category");
  const measures = role(visual, "values").slice(0, 3); // radar : 3 séries max (lisibilité)
  if (!result || !cat || !measures.length) return null;
  const type = columnType(dataset, cat.field);
  const data = result.rows.map((r) => ({
    label: formatDimension(r[bindingKey(cat)] ?? null, type, cat.bin),
    ...Object.fromEntries(measures.map((m) => [bindingKey(m), Number(r[bindingKey(m)] ?? 0)])),
  }));
  const fmt = numberFormat(visual);
  return (
    <div className="flex h-full flex-col">
      <Legend items={measures.map((m, i) => ({ label: bindingLabel(m), color: seriesColor(i) }))} />
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart data={data} outerRadius="62%">
            <PolarGrid stroke="var(--grid)" />
            <PolarAngleAxis dataKey="label" tick={{ fontSize: 11, fill: "var(--muted)" }} />
            <PolarRadiusAxis tick={false} axisLine={false} />
            {measures.map((m, i) => (
              <Radar
                key={bindingKey(m)}
                dataKey={bindingKey(m)}
                name={bindingLabel(m)}
                stroke={seriesColor(i)}
                strokeWidth={2}
                fill={seriesColor(i)}
                fillOpacity={0.15}
                isAnimationActive={false}
              />
            ))}
            <Tooltip
              content={(p) => {
                if (!p.active || !p.payload?.length) return null;
                return (
                  <TooltipBox
                    title={String(p.label ?? "")}
                    rows={p.payload.map((e, i) => ({
                      label: String(e.name),
                      color: seriesColor(i),
                      value: formatNumber(e.value as number, fmt),
                    }))}
                  />
                );
              }}
            />
          </RadarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

interface Step {
  label: string;
  raw: Scalar;
  value: number;
  base: number;
  delta: number;
  kind: "pos" | "neg" | "total";
}

/** Cascade : contribution de chaque catégorie au total (hausse / baisse en divergent bleu / rouge). */
export function WaterfallVisual(props: VisualProps) {
  const { visual, result, dataset, selection, onSelect } = props;
  const cat = first(visual, "category");
  const m = first(visual, "values");
  if (!result || !cat || !m) return null;
  const type = columnType(dataset, cat.field);
  const fmt = numberFormat(visual);

  let running = 0;
  const steps: Step[] = result.rows.map((r) => {
    const delta = Number(r[bindingKey(m)] ?? 0);
    const start = running;
    running += delta;
    return {
      label: formatDimension(r[bindingKey(cat)] ?? null, type, cat.bin),
      raw: r[bindingKey(cat)] ?? null,
      value: Math.abs(delta),
      base: Math.min(start, running),
      delta,
      kind: delta >= 0 ? "pos" : "neg",
    };
  });
  steps.push({ label: "Total", raw: null, value: Math.abs(running), base: Math.min(0, running), delta: running, kind: "total" });
  const color = { pos: "var(--div-pos)", neg: "var(--div-neg)", total: "var(--muted)" };

  return (
    <div className="flex h-full flex-col">
      <Legend
        items={[
          { label: "Hausse", color: color.pos },
          { label: "Baisse", color: color.neg },
          { label: "Total", color: color.total },
        ]}
      />
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={steps} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            <XAxis dataKey="label" {...AXIS} interval="preserveStartEnd" />
            <YAxis {...AXIS} width={56} tickFormatter={(v: number) => formatNumber(v, { ...fmt, compact: true })} />
            <Tooltip
              cursor={{ fill: "var(--surface-2)" }}
              content={(p) => {
                const s = (p.payload?.[0] as { payload?: Step } | undefined)?.payload;
                if (!p.active || !s) return null;
                return (
                  <TooltipBox
                    title={s.label}
                    rows={[{ label: s.kind === "total" ? "Total" : "Variation", value: formatNumber(s.delta, fmt) }]}
                  />
                );
              }}
            />
            <Bar dataKey="base" stackId="w" fill="transparent" isAnimationActive={false} />
            <Bar
              dataKey="value"
              stackId="w"
              maxBarSize={32}
              radius={[4, 4, 4, 4]}
              isAnimationActive={false}
              cursor="pointer"
              onClick={(entry: unknown) => {
                const s = (entry as { payload?: Step }).payload;
                if (s && s.kind !== "total") toggleSelection(selection, visual, cat, s.raw, onSelect);
              }}
            >
              {steps.map((s) => (
                <Cell
                  key={s.label}
                  fill={color[s.kind]}
                  opacity={s.kind !== "total" && dimmed(selection, visual, s.raw) ? 0.3 : 1}
                />
              ))}
            </Bar>
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
