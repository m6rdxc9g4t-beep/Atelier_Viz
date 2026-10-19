/**
 * Rapport de démarrage généré à partir du profil d'un jeu de données (sans IA) :
 * KPI, évolution mensuelle, répartition, carte si un champ géographique est reconnu, segments, table, matrice.
 */

import type { ColumnProfile, DatasetProfile } from "../types/dataset";
import type { Page, Visual, VisualType } from "../types/report";
import { normalize } from "../visuals/maps/geo";
import { migratePage } from "./grid";
import { uid } from "./store";

const GEO_HINTS: Record<string, string> = {
  region: "fr-regions",
  departement: "fr-departements",
  dept: "fr-departements",
  pays: "world",
  country: "world",
};

function v(type: VisualType, dataset: string, layout: Visual["layout"], roles: Visual["roles"], options: Visual["options"] = {}, title: string | null = null): Visual {
  return { id: uid(), type, title, layout, dataset_id: dataset, roles, options, filters: [] };
}

export function starterPages(ds: DatasetProfile): Page[] {
  const nums = ds.columns.filter((c) => c.type === "number" && !/^(id|code|lat|lon|lng)/i.test(c.name));
  const date = ds.columns.find((c) => c.type === "date");
  const cats = ds.columns
    .filter((c) => c.type === "string" && c.distinct >= 2 && c.distinct <= 60)
    .sort((a, b) => a.distinct - b.distinct);
  const geo = ds.columns.find((c) => c.type === "string" && GEO_HINTS[normalize(c.name)]);
  const main: ColumnProfile | undefined = nums.find((c) => /ca|chiffre|montant|vente|revenu|total|amount|sales/i.test(c.name)) ?? nums[0];
  const id = ds.id;
  const visuals: Visual[] = [];

  visuals.push(v("text", "", { x: 0, y: 0, w: 24, h: 3 }, {}, { text: `**${ds.name.replace(/\.[^.]+$/, "")}** — vue d'ensemble`, size: "xl" }));
  if (main) {
    visuals.push(v("kpi", id, { x: 0, y: 3, w: 6, h: 7 }, { values: [{ field: main.name, agg: "sum" }], ...(date ? { trend: [{ field: date.name, bin: "month" }] } : {}) }, { compact: true }, `Total ${main.name}`));
    visuals.push(v("kpi", id, { x: 6, y: 3, w: 6, h: 7 }, { values: [{ field: main.name, agg: "count" }] }, {}, "Nombre de lignes"));
    const second = nums.find((c) => c !== main);
    if (second) visuals.push(v("kpi", id, { x: 12, y: 3, w: 6, h: 7 }, { values: [{ field: second.name, agg: "avg" }] }, { decimals: 1 }, `Moyenne ${second.name}`));
  }
  const slicerField = cats[0];
  if (slicerField) visuals.push(v("slicer", id, { x: 18, y: 3, w: 6, h: 7 }, { field: [{ field: slicerField.name }] }, { style: "tiles" }));

  if (main && date) {
    visuals.push(
      v("column", id, { x: 0, y: 10, w: 14, h: 14 }, {
        category: [{ field: date.name, bin: "month" }],
        ...(cats[0] ? { series: [{ field: cats[0].name }] } : {}),
        values: [{ field: main.name, agg: "sum" }],
      }, { stacked: true, compact: true }),
    );
  }
  const split = cats.find((c) => c !== geo) ?? cats[0];
  if (main && split) {
    visuals.push(v("donut", id, { x: date ? 14 : 0, y: 10, w: 10, h: 14 }, { category: [{ field: split.name }], values: [{ field: main.name, agg: "sum" }] }, { compact: true }));
  }
  if (main && geo) {
    visuals.push(v("map", id, { x: 0, y: 24, w: 10, h: 18 }, { location: [{ field: geo.name }], values: [{ field: main.name, agg: "sum" }] }, { geo: GEO_HINTS[normalize(geo.name)], compact: true }));
  }
  const barField = geo ?? cats[1] ?? cats[0];
  if (main && barField) {
    visuals.push(v("bar", id, { x: geo ? 10 : 0, y: 24, w: geo ? 14 : 24, h: 18 }, { category: [{ field: barField.name }], values: [{ field: main.name, agg: "sum" }] }, { compact: true, sort: "value_desc" }));
  }

  const pages: Page[] = [{ id: uid(), name: "Vue d'ensemble", visuals, filters: [] }];

  const detail: Visual[] = [];
  if (main && cats.length) {
    detail.push(
      v("matrix", id, { x: 0, y: 0, w: 14, h: 18 }, {
        rows: cats.slice(0, 2).map((c) => ({ field: c.name })),
        ...(date ? { columns: [{ field: date.name, bin: "quarter" }] } : {}),
        values: [{ field: main.name, agg: "sum" }],
      }, { compact: true }),
    );
  }
  detail.push(
    v("table", id, { x: main && cats.length ? 14 : 0, y: 0, w: main && cats.length ? 10 : 24, h: 18 }, {
      columns: cats.slice(0, 2).map((c) => ({ field: c.name })),
      values: nums.slice(0, 2).map((c) => ({ field: c.name, agg: "sum" as const })),
    }, { dataBars: true, compact: true, sort: "value_desc" }),
  );
  detail.push(
    v("button", "", { x: 0, y: 18, w: 5, h: 4 }, {}, { label: "Retour à la vue d'ensemble", action: "page", targetPage: pages[0]?.id, variant: "secondary" }),
    v("button", "", { x: 5, y: 18, w: 5, h: 4 }, {}, { label: "Réinitialiser les filtres", action: "reset", variant: "ghost" }),
  );
  pages.push({ id: uid(), name: "Détail", visuals: detail, filters: [] });
  // Composé sur l'ancienne grille de 24 colonnes, converti en pixels (placement libre).
  return pages.map(migratePage);
}
