/** Cartes hors ligne : choroplèthe (régions, départements, pays) et carte à points (lat/lon). */

import type { FeatureCollection, Geometry } from "geojson";
import { type GeoProjection, geoConicConformal, geoNaturalEarth1, geoPath } from "d3-geo";
import { useEffect, useMemo, useState } from "react";

import { useSize } from "../../hooks/useSize";
import type { Scalar } from "../../types/dataset";
import { SequentialLegend, sequential } from "../charts/MoreCharts";
import { columnType } from "../charts/series";
import { Legend, OTHER_COLOR, TooltipBox, VisualMessage, dimmed, first, localPoint, numberFormat, seriesColor, toggleSelection, valueKey } from "../common";
import { bindingKey, bindingLabel } from "../fields";
import { formatDimension, formatNumber } from "../format";
import { opt, type VisualProps } from "../types";
import { type GeoFeature, type GeoLayer, aliasOf, featureKeys, featureName, loadLayer } from "./geo";

type Collection = FeatureCollection<Geometry, GeoFeature["properties"]>;

function useLayer(layer: GeoLayer): { fc: Collection | null; error: string | null } {
  const [state, setState] = useState<{ fc: Collection | null; error: string | null }>({ fc: null, error: null });
  useEffect(() => {
    let alive = true;
    loadLayer(layer)
      .then((fc) => alive && setState({ fc, error: null }))
      .catch((e: unknown) => alive && setState({ fc: null, error: String(e) }));
    return () => {
      alive = false;
    };
  }, [layer]);
  return state;
}

function projectionFor(layer: GeoLayer): GeoProjection {
  // France : Lambert conique conforme (projection officielle) ; monde : Natural Earth.
  return layer === "world" ? geoNaturalEarth1() : geoConicConformal().parallels([44, 49]).rotate([-3, 0]);
}

interface Hover {
  x: number;
  y: number;
  title: string;
  rows: { label: string; value: string }[];
}

export function ChoroplethVisual(props: VisualProps) {
  const { visual, def, result, selection, onSelect } = props;
  const layer = opt<GeoLayer>(visual, def, "geo");
  const loc = first(visual, "location");
  const m = first(visual, "values");
  const { fc, error } = useLayer(layer);
  const [ref, size] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<Hover | null>(null);
  const fmt = numberFormat(visual);

  const { values, unmatched } = useMemo(() => {
    const map = new Map<string, { raw: Scalar; value: number }>();
    if (!result || !loc || !m || !fc) return { values: map, unmatched: 0 };
    const known = new Set(fc.features.flatMap((f) => featureKeys(f as GeoFeature)));
    let miss = 0;
    for (const r of result.rows) {
      const raw = r[bindingKey(loc)] ?? null;
      const key = aliasOf(String(raw ?? ""));
      if (!known.has(key)) miss += 1;
      map.set(key, { raw, value: Number(r[bindingKey(m)] ?? 0) });
    }
    return { values: map, unmatched: miss };
  }, [result, loc, m, fc]);

  if (error) return <VisualMessage tone="error">Fond de carte indisponible : {error}</VisualMessage>;
  if (!loc || !m) return null;

  const numbers = [...values.values()].map((v) => v.value);
  const min = numbers.length ? Math.min(...numbers) : 0;
  const max = numbers.length ? Math.max(...numbers) : 1;
  const projection = fc && size.width > 0 ? projectionFor(layer).fitSize([size.width, size.height], fc) : null;
  const path = projection ? geoPath(projection) : null;

  return (
    <div className="flex h-full flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] text-muted">{unmatched > 0 ? `${unmatched} valeur(s) non reconnue(s)` : ""}</span>
        {numbers.length > 0 && <SequentialLegend min={min} max={max} format={(v) => formatNumber(v, { ...fmt, compact: true })} />}
      </div>
      <div ref={ref} className="relative min-h-0 flex-1" onMouseLeave={() => setHover(null)}>
        {path && fc && (
          <svg width={size.width} height={size.height} role="img" aria-label={`Carte : ${bindingLabel(m)} par ${loc.field}`}>
            {fc.features.map((f, i) => {
              const feat = f as GeoFeature;
              const hit = featureKeys(feat).map((k) => values.get(k)).find(Boolean);
              return (
                <path
                  key={String(feat.properties?.code ?? feat.id ?? i)}
                  d={path(feat) ?? undefined}
                  fill={hit ? sequential(hit.value, min, max) : "var(--surface-2)"}
                  stroke="var(--surface)"
                  strokeWidth={layer === "world" ? 0.5 : 1}
                  opacity={hit && dimmed(selection, visual, hit.raw) ? 0.35 : 1}
                  className={hit ? "cursor-pointer hover:brightness-110" : undefined}
                  onClick={() => hit && toggleSelection(selection, visual, loc, hit.raw, onSelect)}
                  onMouseMove={(e) => {
                    const pt = localPoint(e, e.currentTarget.ownerSVGElement);
                    setHover({
                      x: pt.x,
                      y: pt.y,
                      title: featureName(feat),
                      rows: [{ label: bindingLabel(m), value: hit ? formatNumber(hit.value, fmt) : "—" }],
                    });
                  }}
                />
              );
            })}
          </svg>
        )}
        {hover && (
          <div className="absolute z-10" style={{ left: Math.min(hover.x + 12, size.width - 150), top: hover.y + 12 }}>
            <TooltipBox title={hover.title} rows={hover.rows} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Carte à points : latitude / longitude, taille = mesure, couleur = catégorie (3 max). */
export function PointMapVisual(props: VisualProps) {
  const { visual, def, result, dataset } = props;
  const latB = first(visual, "lat");
  const lonB = first(visual, "lon");
  const sizeB = first(visual, "size");
  const catB = first(visual, "series");
  const labelB = first(visual, "label");
  const layer: GeoLayer = opt<string>(visual, def, "basemap") === "world" ? "world" : "fr-regions";
  const { fc } = useLayer(layer);
  const [ref, size] = useSize<HTMLDivElement>();
  const [hover, setHover] = useState<Hover | null>(null);
  const fmt = numberFormat(visual);

  if (!latB || !lonB) return null;
  const rows = result?.rows ?? [];
  const points = rows
    .map((r) => ({
      lat: Number(r[bindingKey(latB)]),
      lon: Number(r[bindingKey(lonB)]),
      size: sizeB ? Number(r[bindingKey(sizeB)] ?? 0) : 1,
      cat: catB ? (r[bindingKey(catB)] ?? null) : null,
      label: labelB ? formatDimension(r[bindingKey(labelB)] ?? null, columnType(dataset, labelB.field)) : "",
    }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180);
  if (!points.length) return <VisualMessage>Aucun point avec des coordonnées valides.</VisualMessage>;

  const cats = [...new Set(points.map((p) => valueKey(p.cat)))];
  const colorOf = (c: Scalar) => {
    const i = cats.indexOf(valueKey(c));
    return !catB ? seriesColor(0) : i < 2 || cats.length <= 3 ? seriesColor(i) : OTHER_COLOR;
  };
  const maxSize = Math.max(...points.map((p) => Math.abs(p.size)), 1);
  const projection = fc && size.width > 0 ? projectionFor(layer).fitSize([size.width, size.height], fc) : null;
  const path = projection ? geoPath(projection) : null;

  return (
    <div className="flex h-full flex-col">
      {catB && (
        <Legend
          items={[
            ...cats.slice(0, cats.length <= 3 ? 3 : 2).map((c, i) => ({ label: formatDimension(points.find((p) => valueKey(p.cat) === c)?.cat ?? null, columnType(dataset, catB.field)), color: seriesColor(i) })),
            ...(cats.length > 3 ? [{ label: "Autres", color: OTHER_COLOR }] : []),
          ]}
        />
      )}
      <div ref={ref} className="relative min-h-0 flex-1" onMouseLeave={() => setHover(null)}>
        {path && projection && fc && (
          <svg width={size.width} height={size.height} role="img" aria-label={`Carte de ${points.length} points`}>
            {fc.features.map((f, i) => (
              <path key={i} d={path(f) ?? undefined} fill="var(--surface-2)" stroke="var(--border)" strokeWidth={0.75} />
            ))}
            {points
              .sort((a, b) => b.size - a.size)
              .map((p, i) => {
                const xy = projection([p.lon, p.lat]);
                if (!xy) return null;
                const r = sizeB ? 3 + Math.sqrt(Math.abs(p.size) / maxSize) * 14 : 4;
                return (
                  <circle
                    key={i}
                    cx={xy[0]}
                    cy={xy[1]}
                    r={r}
                    fill={colorOf(p.cat)}
                    fillOpacity={0.75}
                    stroke="var(--surface)"
                    strokeWidth={1.5}
                    onMouseMove={(e) => {
                      const pt = localPoint(e, e.currentTarget.ownerSVGElement);
                      const rows = sizeB ? [{ label: bindingLabel(sizeB), value: formatNumber(p.size, fmt) }] : [];
                      rows.push({ label: "Coordonnées", value: `${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}` });
                      setHover({ x: pt.x, y: pt.y, title: p.label, rows });
                    }}
                  />
                );
              })}
          </svg>
        )}
        {hover && (
          <div className="absolute z-10" style={{ left: Math.min(hover.x + 12, size.width - 170), top: hover.y + 12 }}>
            <TooltipBox title={hover.title} rows={hover.rows} />
          </div>
        )}
      </div>
    </div>
  );
}
