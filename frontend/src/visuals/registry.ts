/**
 * Catalogue des visuels. Ajouter un type = ajouter une entrée ici (+ le composant).
 * Rôles = « puits » du volet Visualisations (Axe, Légende, Valeurs…), comme dans Power BI.
 */

import {
  AreaChart,
  BarChart3,
  BarChartHorizontal,
  Blend,
  CircleDot,
  Donut,
  Filter as FilterIcon,
  Gauge,
  Grid3x3,
  LayoutGrid,
  LineChart,
  Map as MapIcon,
  MapPin,
  MousePointerClick,
  PieChart,
  Radar,
  Rows3,
  Sigma,
  Table2,
  TrendingDown,
  Triangle,
  Type,

} from "lucide-react";

import type { Visual, VisualType } from "../types/report";
import { CartesianVisual } from "./charts/CartesianVisual";
import { GaugeVisual, HeatmapVisual, ScatterVisual } from "./charts/MoreCharts";
import { FunnelVisual, PieVisual, RadarVisual, TreemapVisual, WaterfallVisual } from "./charts/PartVisuals";
import { LABELS_OPTION, LEGEND_OPTION, NUMBER_OPTIONS, SORT_OPTIONS, first, genericQuery, isReady, role } from "./common";
import { KpiVisual } from "./data/KpiVisual";
import { MatrixVisual } from "./data/MatrixVisual";
import { matrixQuery } from "./data/pivot";
import { TableVisual } from "./data/TableVisual";
import { ButtonVisual, TextVisual } from "./interactive/ButtonVisual";
import { SlicerVisual } from "./interactive/SlicerVisual";
import { GEO_LAYERS } from "./maps/geo";
import { ChoroplethVisual, PointMapVisual } from "./maps/MapVisuals";
import type { OptionDef, RoleDef, VisualDef } from "./types";

const CATEGORY: RoleDef = { id: "category", label: "Axe", kind: "dimension", max: 1, required: true };
const LEGEND: RoleDef = { id: "series", label: "Légende", kind: "dimension", max: 1 };
const VALUES: RoleDef = { id: "values", label: "Valeurs", kind: "measure", required: true };
const ONE_VALUE: RoleDef = { ...VALUES, max: 1 };

const STACK_OPTIONS: OptionDef[] = [
  { key: "stacked", label: "Empilé", type: "boolean", section: "Affichage" },
  { key: "percent", label: "Empilé à 100 %", type: "boolean", section: "Affichage" },
];
const LINE_OPTIONS: OptionDef[] = [
  { key: "smooth", label: "Courbe lissée", type: "boolean", section: "Affichage" },
  { key: "markers", label: "Marqueurs", type: "boolean", section: "Affichage" },
];

const chart = (
  type: VisualType,
  label: string,
  icon: VisualDef["icon"],
  extra: Partial<VisualDef> = {},
): VisualDef => ({
  type,
  label,
  icon,
  group: "Graphiques",
  roles: [CATEGORY, LEGEND, VALUES],
  size: { w: 8, h: 14 },
  defaults: { legend: true, labels: false, sort: "category" },
  options: [LEGEND_OPTION, LABELS_OPTION, ...SORT_OPTIONS, ...NUMBER_OPTIONS],
  component: CartesianVisual,
  query: (v, f) => genericQuery(v, VISUALS[type], f),
  ...extra,
});

export const VISUALS: Record<VisualType, VisualDef> = {
  column: chart("column", "Histogramme", BarChart3, {
    options: [LEGEND_OPTION, LABELS_OPTION, ...STACK_OPTIONS, ...SORT_OPTIONS, ...NUMBER_OPTIONS],
  }),
  bar: chart("bar", "Barres horizontales", BarChartHorizontal, {
    defaults: { legend: true, labels: true, sort: "value_desc" },
    options: [LEGEND_OPTION, LABELS_OPTION, ...STACK_OPTIONS, ...SORT_OPTIONS, ...NUMBER_OPTIONS],
  }),
  line: chart("line", "Courbes", LineChart, {
    defaults: { legend: true, labels: false, sort: "category", smooth: false, markers: true },
    options: [LEGEND_OPTION, LABELS_OPTION, ...LINE_OPTIONS, ...NUMBER_OPTIONS],
  }),
  area: chart("area", "Aires", AreaChart, {
    defaults: { legend: true, labels: false, sort: "category", smooth: true },
    options: [LEGEND_OPTION, LABELS_OPTION, ...STACK_OPTIONS, ...LINE_OPTIONS, ...NUMBER_OPTIONS],
  }),
  combo: chart("combo", "Combiné barres + courbes", Blend, {
    roles: [CATEGORY, { id: "values", label: "Colonnes", kind: "measure" }, { id: "lines", label: "Courbes", kind: "measure" }],
    defaults: { legend: true, labels: false, sort: "category", markers: true },
    options: [LEGEND_OPTION, LABELS_OPTION, { key: "stacked", label: "Colonnes empilées", type: "boolean", section: "Affichage" }, ...LINE_OPTIONS, ...NUMBER_OPTIONS],
  }),
  pie: chart("pie", "Secteurs", PieChart, {
    roles: [{ ...CATEGORY, label: "Légende" }, ONE_VALUE],
    size: { w: 6, h: 14 },
    defaults: { legend: true, labels: true, sort: "value_desc" },
    options: [LEGEND_OPTION, LABELS_OPTION, ...NUMBER_OPTIONS],
    component: PieVisual,
  }),
  donut: chart("donut", "Anneau", Donut, {
    roles: [{ ...CATEGORY, label: "Légende" }, ONE_VALUE],
    size: { w: 6, h: 14 },
    defaults: { legend: true, labels: false, sort: "value_desc" },
    options: [LEGEND_OPTION, LABELS_OPTION, ...NUMBER_OPTIONS],
    component: PieVisual,
  }),
  treemap: chart("treemap", "Treemap", LayoutGrid, {
    roles: [{ ...CATEGORY, label: "Catégorie" }, ONE_VALUE],
    defaults: { sort: "value_desc", topN: 30 },
    options: [...SORT_OPTIONS, ...NUMBER_OPTIONS],
    component: TreemapVisual,
  }),
  funnel: chart("funnel", "Entonnoir", Triangle, {
    roles: [{ ...CATEGORY, label: "Étapes" }, ONE_VALUE],
    defaults: { sort: "value_desc" },
    options: [...SORT_OPTIONS, ...NUMBER_OPTIONS],
    component: FunnelVisual,
  }),
  radar: chart("radar", "Radar", Radar, {
    roles: [CATEGORY, { ...VALUES, max: 3 }],
    defaults: { sort: "category" },
    options: NUMBER_OPTIONS,
    component: RadarVisual,
  }),
  waterfall: chart("waterfall", "Cascade", TrendingDown, {
    roles: [CATEGORY, ONE_VALUE],
    defaults: { sort: "category" },
    options: [...SORT_OPTIONS, ...NUMBER_OPTIONS],
    component: WaterfallVisual,
  }),
  scatter: chart("scatter", "Nuage de points", CircleDot, {
    roles: [
      { id: "details", label: "Détails (un point par…)", kind: "dimension", max: 1, required: true },
      { ...LEGEND, label: "Légende (3 max)" },
      { id: "x", label: "Axe X", kind: "measure", max: 1, required: true },
      { id: "y", label: "Axe Y", kind: "measure", max: 1, required: true },
      { id: "size", label: "Taille", kind: "measure", max: 1 },
    ],
    defaults: {},
    options: NUMBER_OPTIONS,
    component: ScatterVisual,
  }),
  gauge: chart("gauge", "Jauge", Gauge, {
    roles: [ONE_VALUE, { id: "target", label: "Cible", kind: "measure", max: 1 }],
    size: { w: 5, h: 10 },
    defaults: { min: 0 },
    options: [
      { key: "min", label: "Minimum", type: "number", section: "Plage" },
      { key: "max", label: "Maximum (vide = auto)", type: "number", section: "Plage" },
      { key: "target", label: "Cible fixe", type: "number", section: "Plage" },
      ...NUMBER_OPTIONS,
    ],
    component: GaugeVisual,
  }),
  heatmap: chart("heatmap", "Carte de chaleur", Grid3x3, {
    roles: [
      { id: "x", label: "Colonnes", kind: "dimension", max: 1, required: true },
      { id: "y", label: "Lignes", kind: "dimension", max: 1, required: true },
      ONE_VALUE,
    ],
    defaults: { sort: "category" },
    options: NUMBER_OPTIONS,
    component: HeatmapVisual,
  }),

  kpi: {
    type: "kpi",
    label: "Carte KPI",
    icon: Sigma,
    group: "Données",
    roles: [
      ONE_VALUE,
      { id: "target", label: "Cible", kind: "measure", max: 1 },
      { id: "trend", label: "Tendance (date)", kind: "dimension", max: 1, types: ["date"] },
    ],
    size: { w: 5, h: 7 },
    defaults: { higherIsBetter: true },
    options: [{ key: "higherIsBetter", label: "Plus haut = mieux", type: "boolean", section: "Affichage" }, ...NUMBER_OPTIONS],
    component: KpiVisual,
    query: (v, f) => {
      if (!v.dataset_id || !isReady(v, VISUALS.kpi)) return null;
      const req = genericQuery({ ...v, roles: { values: role(v, "values"), target: role(v, "target") } }, VISUALS.kpi, f);
      return req && { ...req, dimensions: [], sort: [] };
    },
  },
  table: {
    type: "table",
    label: "Table",
    icon: Table2,
    group: "Données",
    roles: [
      { id: "columns", label: "Colonnes", kind: "dimension" },
      { id: "values", label: "Valeurs", kind: "measure" },
    ],
    size: { w: 8, h: 14 },
    defaults: { totals: true, dataBars: false, sort: "category" },
    options: [
      { key: "totals", label: "Ligne de total", type: "boolean", section: "Affichage" },
      { key: "dataBars", label: "Barres de données", type: "boolean", section: "Affichage" },
      ...SORT_OPTIONS,
      ...NUMBER_OPTIONS,
    ],
    component: TableVisual,
    query: (v, f) => genericQuery(v, VISUALS.table, f, 5000),
  },
  matrix: {
    type: "matrix",
    label: "Matrice",
    icon: Rows3,
    group: "Données",
    roles: [
      { id: "rows", label: "Lignes", kind: "dimension", required: true },
      { id: "columns", label: "Colonnes", kind: "dimension", max: 1 },
      VALUES,
    ],
    size: { w: 10, h: 14 },
    defaults: { expanded: false },
    options: [{ key: "expanded", label: "Tout développer", type: "boolean", section: "Affichage" }, ...NUMBER_OPTIONS],
    component: MatrixVisual,
    query: (v, f) =>
      v.dataset_id && isReady(v, VISUALS.matrix)
        ? matrixQuery(v.dataset_id, role(v, "rows"), first(v, "columns"), role(v, "values"), f)
        : null,
  },

  map: {
    type: "map",
    label: "Carte choroplèthe",
    icon: MapIcon,
    group: "Cartes",
    roles: [
      { id: "location", label: "Emplacement (nom ou code)", kind: "dimension", max: 1, required: true, types: ["string", "number"] },
      ONE_VALUE,
    ],
    size: { w: 8, h: 16 },
    defaults: { geo: "fr-regions" },
    options: [{ key: "geo", label: "Fond de carte", type: "select", choices: GEO_LAYERS, section: "Carte" }, ...NUMBER_OPTIONS],
    component: ChoroplethVisual,
    query: (v, f) => genericQuery(v, VISUALS.map, f, 5000),
  },
  pointmap: {
    type: "pointmap",
    label: "Carte à points",
    icon: MapPin,
    group: "Cartes",
    roles: [
      { id: "lat", label: "Latitude", kind: "dimension", max: 1, required: true, types: ["number"] },
      { id: "lon", label: "Longitude", kind: "dimension", max: 1, required: true, types: ["number"] },
      { id: "size", label: "Taille", kind: "measure", max: 1 },
      { ...LEGEND, label: "Couleur (3 max)" },
      { id: "label", label: "Info-bulle", kind: "dimension", max: 1 },
    ],
    size: { w: 8, h: 16 },
    defaults: { basemap: "france" },
    options: [
      {
        key: "basemap",
        label: "Fond de carte",
        type: "select",
        choices: [
          { value: "france", label: "France" },
          { value: "world", label: "Monde" },
        ],
        section: "Carte",
      },
      ...NUMBER_OPTIONS,
    ],
    component: PointMapVisual,
    query: (v, f) => genericQuery(v, VISUALS.pointmap, f, 10000),
  },

  slicer: {
    type: "slicer",
    label: "Segment (filtre)",
    icon: FilterIcon,
    group: "Interactivité",
    roles: [{ id: "field", label: "Champ", kind: "dimension", max: 1, required: true }],
    size: { w: 4, h: 10 },
    defaults: { style: "list", multi: true, search: true },
    options: [
      {
        key: "style",
        label: "Style",
        type: "select",
        section: "Segment",
        choices: [
          { value: "list", label: "Liste" },
          { value: "dropdown", label: "Liste déroulante" },
          { value: "tiles", label: "Vignettes" },
          { value: "range", label: "Plage (nombres, dates)" },
        ],
      },
      { key: "multi", label: "Sélection multiple", type: "boolean", section: "Segment", when: (o) => o.style !== "range" && o.style !== "dropdown" },
      { key: "search", label: "Recherche", type: "boolean", section: "Segment", when: (o) => (o.style ?? "list") === "list" },
    ],
    component: SlicerVisual,
    query: (v: Visual, f) => {
      const field = first(v, "field");
      if (!v.dataset_id || !field) return null;
      if ((v.options.style ?? "list") === "range") {
        return { dataset_id: v.dataset_id, measures: [{ field: field.field, agg: "min" }, { field: field.field, agg: "max" }], filters: f };
      }
      return {
        dataset_id: v.dataset_id,
        dimensions: [{ field: field.field, bin: field.bin ?? null }],
        measures: [{ agg: "count" }],
        filters: f,
        limit: 1000,
      };
    },
  },
  button: {
    type: "button",
    label: "Bouton d'action",
    icon: MousePointerClick,
    group: "Interactivité",
    roles: [],
    size: { w: 4, h: 4 },
    defaults: { label: "Ouvrir", action: "url", url: "https://", method: "POST", variant: "primary", confirm: true },
    options: [
      { key: "label", label: "Libellé", type: "text", section: "Bouton" },
      {
        key: "action",
        label: "Action",
        type: "select",
        section: "Bouton",
        choices: [
          { value: "url", label: "Ouvrir une URL" },
          { value: "webhook", label: "Appeler un webhook (automatisation)" },
          { value: "page", label: "Aller à une page" },
          { value: "reset", label: "Réinitialiser les filtres" },
        ],
      },
      { key: "url", label: "URL — variables : {champ}, {page}, {rapport}, {date}", type: "text", section: "Bouton", when: (o) => o.action === "url" || o.action === "webhook" || o.action === undefined },
      {
        key: "method",
        label: "Méthode",
        type: "select",
        section: "Bouton",
        choices: [
          { value: "POST", label: "POST (filtres en JSON)" },
          { value: "GET", label: "GET" },
        ],
        when: (o) => o.action === "webhook",
      },
      { key: "confirm", label: "Demander confirmation", type: "boolean", section: "Bouton", when: (o) => o.action === "webhook" },
      { key: "targetPage", label: "Page cible", type: "select", section: "Bouton", when: (o) => o.action === "page" },
      {
        key: "variant",
        label: "Apparence",
        type: "select",
        section: "Bouton",
        choices: [
          { value: "primary", label: "Principal" },
          { value: "secondary", label: "Secondaire" },
          { value: "ghost", label: "Discret" },
        ],
      },
    ],
    component: ButtonVisual,
  },
  text: {
    type: "text",
    label: "Zone de texte",
    icon: Type,
    group: "Interactivité",
    roles: [],
    size: { w: 8, h: 4 },
    defaults: { text: "**Titre**\nTexte libre — gras avec **…**, puces avec « - ».", size: "md", align: "left" },
    options: [
      { key: "text", label: "Texte", type: "textarea", section: "Texte" },
      {
        key: "size",
        label: "Taille",
        type: "select",
        section: "Texte",
        choices: [
          { value: "sm", label: "Petit" },
          { value: "md", label: "Normal" },
          { value: "lg", label: "Grand" },
          { value: "xl", label: "Titre" },
        ],
      },
      {
        key: "align",
        label: "Alignement",
        type: "select",
        section: "Texte",
        choices: [
          { value: "left", label: "Gauche" },
          { value: "center", label: "Centré" },
          { value: "right", label: "Droite" },
        ],
      },
    ],
    component: TextVisual,
  },
};

export const VISUAL_GROUPS: { group: VisualDef["group"]; items: VisualDef[] }[] = (
  ["Graphiques", "Données", "Cartes", "Interactivité"] as const
).map((group) => ({ group, items: Object.values(VISUALS).filter((d) => d.group === group) }));


