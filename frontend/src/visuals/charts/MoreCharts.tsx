/** Nuage de points, jauge, carte de chaleur. */

import { useMemo, useState } from "react";
import { CartesianGrid, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from "recharts";

import type { Scalar } from "../../types/dataset";
import { AXIS, Legend, OTHER_COLOR, TooltipBox, VisualMessage, first, numberFormat, seriesColor, valueKey } from "../common";
import { bindingKey, bindingLabel } from "../fields";
import { formatDimension, formatNumber } from "../format";
import { opt, type VisualProps } from "../types";
import { columnType } from "./series";

/** Nuage : 3 couleurs max (au-delà, les paires ne sont plus distinguables) puis « Autres ». */
const SCATTER_COLORS = 3;

export function ScatterVisual(props: VisualProps) {
  const { visual, result, dataset } = props;
  const details = first(visual, "details");
  const x = first(visual, "x");
  const y = first(visual, "y");
  const size = first(visual, "size");
  const legend = first(visual, "series");
  const fmt = numberFormat(visual);

  const groups = useMemo(() => {
    if (!result || !x || !y) return [];
    const legendType = columnType(dataset, legend?.field);
    const detailType = columnType(dataset, details?.field);
    const totals = new Map<string, { raw: Scalar; n: number }>();
    for (const r of result.rows) {
      const k = legend ? valueKey(r[bindingKey(legend)] ?? null) : "all";
      const t = totals.get(k) ?? { raw: legend ? (r[bindingKey(legend)] ?? null) : null, n: 0 };
      t.n += 1;
      totals.set(k, t);
    }
    const ranked = [...totals.entries()].sort((a, b) => b[1].n - a[1].n);
    const kept = ranked.slice(0, ranked.length > SCATTER_COLORS ? SCATTER_COLORS - 1 : SCATTER_COLORS).map(([k]) => k);
    const out = new Map<string, { label: string; color: string; points: Record<string, unknown>[] }>();
    kept.forEach((k, i) => {
      const raw = totals.get(k)?.raw ?? null;
      out.set(k, { label: legend ? formatDimension(raw, legendType, legend.bin) : bindingLabel(y), color: seriesColor(i), points: [] });
    });
    for (const r of result.rows) {
      const k = legend ? valueKey(r[bindingKey(legend)] ?? null) : "all";
      const g = out.get(k) ?? out.get("__other") ?? out.set("__other", { label: "Autres", color: OTHER_COLOR, points: [] }).get("__other");
      g?.points.push({
        x: Number(r[bindingKey(x)]),
        y: Number(r[bindingKey(y)]),
        z: size ? Number(r[bindingKey(size)] ?? 0) : 1,
        name: details ? formatDimension(r[bindingKey(details)] ?? null, detailType, details.bin) : "",
      });
    }
    return [...out.values()];
  }, [result, dataset, x, y, size, legend, details]);

  if (!x || !y) return null;
  if (!groups.some((g) => g.points.length)) return <VisualMessage>Aucune donnée pour ces filtres.</VisualMessage>;

  return (
    <div className="flex h-full flex-col">
      <Legend items={groups.map((g) => ({ label: g.label, color: g.color }))} />
      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
            <CartesianGrid stroke="var(--grid)" />
            <XAxis type="number" dataKey="x" name={bindingLabel(x)} {...AXIS} tickFormatter={(v: number) => formatNumber(v, { compact: true })} />
            <YAxis type="number" dataKey="y" name={bindingLabel(y)} {...AXIS} width={56} tickFormatter={(v: number) => formatNumber(v, { compact: true })} />
            <ZAxis type="number" dataKey="z" range={size ? [40, 600] : [64, 64]} />
            <Tooltip
              cursor={{ stroke: "var(--grid)" }}
              content={(p) => {
                const d = (p.payload?.[0] as { payload?: { x: number; y: number; z: number; name: string } } | undefined)?.payload;
                if (!p.active || !d) return null;
                const rows = [
                  { label: bindingLabel(x), value: formatNumber(d.x, fmt) },
                  { label: bindingLabel(y), value: formatNumber(d.y, fmt) },
                ];
                if (size) rows.push({ label: bindingLabel(size), value: formatNumber(d.z, fmt) });
                return <TooltipBox title={d.name} rows={rows} />;
              }}
            />
            {groups.map((g) => (
              <Scatter
                key={g.label}
                name={g.label}
                data={g.points}
                fill={g.color}
                fillOpacity={0.8}
                stroke="var(--surface)"
                strokeWidth={1.5}
                isAnimationActive={false}
              />
            ))}
          </ScatterChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** Jauge demi-cercle : valeur, plage min–max, cible éventuelle (mesure ou option). */
export function GaugeVisual(props: VisualProps) {
  const { visual, def, result } = props;
  const valueB = first(visual, "values");
  const targetB = first(visual, "target");
  const row = result?.rows[0];
  if (!valueB || !row) return null;
  const fmt = numberFormat(visual);
  const value = Number(row[bindingKey(valueB)] ?? 0);
  const targetOpt = opt<number | undefined>(visual, def, "target");
  const target = targetB ? Number(row[bindingKey(targetB)] ?? 0) : typeof targetOpt === "number" ? targetOpt : undefined;
  const min = Number(opt<number>(visual, def, "min") ?? 0);
  const maxOpt = opt<number | undefined>(visual, def, "max");
  const max = typeof maxOpt === "number" && maxOpt > min ? maxOpt : Math.max(value, target ?? 0, 1) * 1.2;
  const ratio = (v: number) => Math.min(1, Math.max(0, (v - min) / (max - min)));

  const R = 80;
  const point = (t: number, r = R) => {
    const a = Math.PI * (1 - t);
    return [100 + r * Math.cos(a), 100 - r * Math.sin(a)] as const;
  };
  const arc = (t: number) => {
    const [x, y] = point(t);
    return `M ${100 - R} 100 A ${R} ${R} 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)}`;
  };
  const [tx1, ty1] = point(ratio(target ?? 0), R - 16);
  const [tx2, ty2] = point(ratio(target ?? 0), R + 16);

  return (
    <div className="flex h-full flex-col items-center justify-center">
      <svg viewBox="0 0 200 118" className="h-full max-h-56 w-full" role="img" aria-label={`${bindingLabel(valueB)} : ${formatNumber(value, fmt)}`}>
        <path d={arc(1)} fill="none" stroke="var(--surface-2)" strokeWidth={18} />
        <path d={arc(ratio(value))} fill="none" stroke="var(--series-1)" strokeWidth={18} />
        {target !== undefined && (
          <line x1={tx1} y1={ty1} x2={tx2} y2={ty2} stroke="var(--fg)" strokeWidth={2.5} strokeLinecap="round" />
        )}
        <text x={100} y={92} textAnchor="middle" fontSize={22} fontWeight={600} fill="var(--fg)">
          {formatNumber(value, { ...fmt, compact: Math.abs(value) >= 1e5 || fmt.compact })}
        </text>
        <text x={100 - R} y={114} textAnchor="middle" fontSize={9} fill="var(--muted)">
          {formatNumber(min, { compact: true })}
        </text>
        <text x={100 + R} y={114} textAnchor="middle" fontSize={9} fill="var(--muted)">
          {formatNumber(max, { compact: true })}
        </text>
      </svg>
      {target !== undefined && (
        <p className="text-xs text-muted">
          Cible {formatNumber(target, fmt)} · {Math.round((value / (target || 1)) * 100)} %
        </p>
      )}
    </div>
  );
}

const SEQ = ["--seq-100", "--seq-200", "--seq-300", "--seq-400", "--seq-500", "--seq-600", "--seq-700"];

/** Couleur séquentielle (7 pas) pour une valeur dans [min, max]. */
export function sequential(value: number, min: number, max: number): string {
  const t = max > min ? (value - min) / (max - min) : 0.5;
  return `var(${SEQ[Math.min(SEQ.length - 1, Math.max(0, Math.floor(t * SEQ.length)))]})`;
}

export function SequentialLegend({ min, max, format }: { min: number; max: number; format: (v: number) => string }) {
  return (
    <div className="flex items-center gap-2 text-[10px] text-muted">
      <span className="tabular-nums">{format(min)}</span>
      <span className="flex h-2 w-24 overflow-hidden rounded-full">
        {SEQ.map((s) => (
          <span key={s} className="flex-1" style={{ background: `var(${s})` }} />
        ))}
      </span>
      <span className="tabular-nums">{format(max)}</span>
    </div>
  );
}

/** Carte de chaleur : X × Y, intensité = mesure (rampe séquentielle à une teinte). */
export function HeatmapVisual(props: VisualProps) {
  const { visual, result, dataset } = props;
  const xb = first(visual, "x");
  const yb = first(visual, "y");
  const m = first(visual, "values");
  const [hover, setHover] = useState<string | null>(null);
  if (!result || !xb || !yb || !m) return null;
  const fmt = numberFormat(visual);
  const xType = columnType(dataset, xb.field);
  const yType = columnType(dataset, yb.field);
  const xs: Scalar[] = [];
  const ys: Scalar[] = [];
  const cells = new Map<string, number>();
  for (const r of result.rows) {
    const xv = r[bindingKey(xb)] ?? null;
    const yv = r[bindingKey(yb)] ?? null;
    if (!xs.some((v) => valueKey(v) === valueKey(xv))) xs.push(xv);
    if (!ys.some((v) => valueKey(v) === valueKey(yv))) ys.push(yv);
    cells.set(`${valueKey(xv)}§${valueKey(yv)}`, Number(r[bindingKey(m)] ?? 0));
  }
  if (!cells.size) return <VisualMessage>Aucune donnée pour ces filtres.</VisualMessage>;
  const values = [...cells.values()];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const X = xs.slice(0, 40);
  const Y = ys.slice(0, 40);

  return (
    <div className="flex h-full flex-col gap-1">
      <div className="flex justify-end">
        <SequentialLegend min={min} max={max} format={(v) => formatNumber(v, { ...fmt, compact: true })} />
      </div>
      <div
        className="grid min-h-0 flex-1 gap-0.5 text-[10px]"
        style={{ gridTemplateColumns: `minmax(48px,auto) repeat(${X.length}, minmax(0,1fr))`, gridTemplateRows: `repeat(${Y.length}, minmax(0,1fr)) auto` }}
      >
        {Y.map((yv) => (
          <div key={`row-${valueKey(yv)}`} className="contents">
            <span className="truncate pr-1 text-right text-muted" style={{ alignSelf: "center" }}>
              {formatDimension(yv, yType, yb.bin)}
            </span>
            {X.map((xv) => {
              const k = `${valueKey(xv)}§${valueKey(yv)}`;
              const v = cells.get(k);
              return (
                <div
                  key={k}
                  onMouseEnter={() => setHover(k)}
                  onMouseLeave={() => setHover(null)}
                  title={`${formatDimension(xv, xType, xb.bin)} · ${formatDimension(yv, yType, yb.bin)} : ${v === undefined ? "—" : formatNumber(v, fmt)}`}
                  className="rounded-sm"
                  style={{
                    background: v === undefined ? "var(--surface-2)" : sequential(v, min, max),
                    outline: hover === k ? "2px solid var(--fg)" : undefined,
                  }}
                />
              );
            })}
          </div>
        ))}
        <span />
        {X.map((xv) => (
          <span key={`col-${valueKey(xv)}`} className="truncate text-center text-muted">
            {formatDimension(xv, xType, xb.bin)}
          </span>
        ))}
      </div>
    </div>
  );
}
