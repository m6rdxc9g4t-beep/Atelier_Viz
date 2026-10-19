/** Mise en forme des résultats en séries (catégorie × série) pour les graphiques cartésiens. */

import type { ColumnType, DatasetProfile, Scalar } from "../../types/dataset";
import type { FieldBinding, Visual } from "../../types/report";
import { MAX_SERIES, OTHER_COLOR, role, seriesColor, valueKey } from "../common";
import { type ColorMap, colorDomain } from "../useStableColors";
import { bindingKey, bindingLabel } from "../fields";
import { formatDimension } from "../format";
import type { QueryResult } from "../useQueryResult";

export interface Datum {
  __cat: Scalar;
  __label: string;
  [series: string]: Scalar;
}

export interface SeriesDef {
  key: string;
  label: string;
  color: string;
  /** Rôle d'origine (combo : barres ou lignes). */
  role: string;
}

export interface Shaped {
  data: Datum[];
  series: SeriesDef[];
  category: FieldBinding | undefined;
}

export function columnType(dataset: DatasetProfile | undefined, field: string | undefined): ColumnType | undefined {
  return dataset?.columns.find((c) => c.name === field)?.type;
}

/**
 * - avec un champ « Légende » : pivot (une série par valeur, 8 max + « Autres ») ;
 * - sinon : une série par mesure des rôles `measureRoles`.
 */
export function shapeSeries(
  visual: Visual,
  result: QueryResult,
  dataset: DatasetProfile | undefined,
  measureRoles: string[] = ["values"],
  colors: ColorMap | null = null,
): Shaped {
  const category = role(visual, "category")[0];
  const legend = role(visual, "series")[0];
  const catKey = category ? bindingKey(category) : null;
  const catType = columnType(dataset, category?.field);
  const label = (v: Scalar) => formatDimension(v, catType, category?.bin);

  const byCat = new Map<string, Datum>();
  const datum = (cat: Scalar): Datum => {
    const k = valueKey(cat);
    let d = byCat.get(k);
    if (!d) {
      d = { __cat: cat, __label: catKey ? label(cat) : "Total" };
      byCat.set(k, d);
    }
    return d;
  };

  if (legend) {
    const measureBinding = role(visual, measureRoles[0] ?? "values")[0];
    if (!measureBinding) return { data: [], series: [], category };
    const mKey = bindingKey(measureBinding);
    const sKey = bindingKey(legend);
    const sType = columnType(dataset, legend.field);

    const totals = new Map<string, { value: Scalar; total: number }>();
    for (const row of result.rows) {
      const k = valueKey(row[sKey] ?? null);
      const t = totals.get(k) ?? { value: row[sKey] ?? null, total: 0 };
      t.total += Math.abs(Number(row[mKey] ?? 0));
      totals.set(k, t);
    }
    const ranked = [...totals.entries()].sort((a, b) => b[1].total - a[1].total);
    // Domaine de couleurs stable (sans filtres) s'il est connu ; sinon classement local en attendant.
    const domain = colors ?? colorDomain(ranked.map(([k]) => k));
    const kept = new Set(ranked.map(([k]) => k).filter((k) => domain.has(k) && domain.get(k) !== OTHER_COLOR));
    const hasOther = ranked.length > kept.size;
    const order = [...domain.keys()];

    for (const row of result.rows) {
      const d = datum(catKey ? (row[catKey] ?? null) : null);
      const k = valueKey(row[sKey] ?? null);
      const target = kept.has(k) ? `s:${k}` : "s:__other";
      d[target] = Number(d[target] ?? 0) + Number(row[mKey] ?? 0);
    }
    // La couleur suit la valeur (domaine complet), pas son rang dans le résultat filtré.
    const ordered = ranked.filter(([k]) => kept.has(k)).sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
    const series: SeriesDef[] = ordered.map(([k, v]) => ({
      key: `s:${k}`,
      label: formatDimension(v.value, sType, legend.bin),
      color: domain.get(k) ?? OTHER_COLOR,
      role: measureRoles[0] ?? "values",
    }));
    if (hasOther) series.push({ key: "s:__other", label: "Autres", color: OTHER_COLOR, role: measureRoles[0] ?? "values" });
    return { data: [...byCat.values()], series, category };
  }

  const measures = measureRoles.flatMap((r) => role(visual, r).map((b) => ({ b, r })));
  for (const row of result.rows) {
    const d = datum(catKey ? (row[catKey] ?? null) : null);
    for (const { b } of measures) d[bindingKey(b)] = row[bindingKey(b)] ?? null;
  }
  const series = measures.slice(0, MAX_SERIES).map(({ b, r }, i) => ({
    key: bindingKey(b),
    label: bindingLabel(b),
    color: seriesColor(i),
    role: r,
  }));
  return { data: [...byCat.values()], series, category };
}
