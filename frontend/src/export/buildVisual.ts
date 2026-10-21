/**
 * Conversion d'un visuel en éléments de diapositive.
 *
 * Natifs (modifiables dans PowerPoint) : histogrammes, barres, courbes, aires, combiné, secteurs,
 * anneau, radar, nuage de points (sans légende), KPI, table, matrice, segment, texte, bouton.
 * En image (rendu identique à l'écran) : ce que PowerPoint ne sait pas tracer nativement
 * (cartes, treemap, entonnoir, cascade, jauge, carte de chaleur, nuage de points par groupe),
 * et tous les visuels de données en mode « Images ».
 */

import type { DatasetProfile, Scalar } from "../types/dataset";
import type { Filter } from "../types/query";
import type { Visual } from "../types/report";
import type { VisualStyle } from "../theme/reportTheme";
import { type Slice, slices } from "../visuals/charts/PartVisuals";
import { columnType, shapeSeries } from "../visuals/charts/series";
import { first, isReady, numberFormat, role, valueKey } from "../visuals/common";
import { kpiGap } from "../visuals/data/KpiVisual";
import { type MatrixNode, buildMatrix } from "../visuals/data/pivot";
import { type CondFormat, type Stats, GLYPHS, decorHex, decorate, formatFor, isFormatted, statsOf } from "../visuals/data/conditional";
import { SCALES } from "../theme/scales";
import { bindingKey, bindingLabel } from "../visuals/fields";
import { formatDimension, formatNumber } from "../visuals/format";
import { type ButtonAction, isSafeUrl, renderTemplate } from "../visuals/interactive/actions";
import { slicerFilter } from "../studio/filters";
import { opt, type VisualDef } from "../visuals/types";
import type { ColorMap } from "../visuals/useStableColors";
import type { QueryResult } from "../visuals/useQueryResult";
import { defaultTitle } from "../visuals/title";
import { type ExportTheme, type VisualColors, pptColor, resolveColor, visualColors } from "./colors";
import type { ChartLayer, ChartSeries, Link, SlideItem, TableCell, TextRun } from "./items";
import { type Rect, fontPt, inset } from "./layout";
import { excelFormat } from "./numberFormat";

export type ExportMode = "native" | "image";

/** Données d'un visuel, chargées avant la construction de la diapositive. */
export interface VisualData {
  result: QueryResult | null;
  error: string | null;
  /** Domaine de couleurs stable (champ « Légende » ou catégorie des secteurs). */
  colors: ColorMap | null;
  /** Mini-tendance des KPI. */
  trend: QueryResult | null;
}

export interface BuildContext {
  visual: Visual;
  def: VisualDef;
  dataset: DatasetProfile | undefined;
  data: VisualData;
  /** Rectangle du visuel sur la diapositive (pouces). */
  rect: Rect;
  /** Pouces par px d'écran. */
  scale: number;
  theme: ExportTheme;
  mode: ExportMode;
  /** Image du corps du visuel (PNG en data URL), quand `needsImage` l'a demandée. */
  image?: string | null;
  /** Liens des boutons : numéro de diapositive d'une page, contexte des gabarits d'URL. */
  links: { slideOf: (pageId: string) => number | undefined; page: string; report: string; filters: Filter[] };
}

export interface BuiltVisual {
  items: SlideItem[];
  /** Le corps est-il natif (modifiable) ? Faux pour une image. */
  native: boolean;
  warnings: string[];
}

const BARE_TYPES = new Set(["button", "text"]);
/** Types sans équivalent natif PowerPoint (exportés en image). */
const IMAGE_ONLY = new Set(["gauge", "treemap", "funnel", "waterfall", "heatmap", "map", "pointmap"]);

/** Le corps de ce visuel doit-il être capturé en image ? */
export function needsImage(visual: Visual, def: VisualDef, mode: ExportMode): boolean {
  if (!def.query || BARE_TYPES.has(visual.type) || !isReady(visual, def)) return false;
  if (mode === "image") return true;
  if (IMAGE_ONLY.has(visual.type)) return true;
  return visual.type === "scatter" && role(visual, "series").length > 0;
}

/** Géométrie du cadre (px d'écran) : marge intérieure, hauteur du titre, espace sous le titre. */
export const FRAME = { pad: 12, barePad: 6, title: 20, gap: 6 } as const;

export interface FrameGeometry {
  showTitle: boolean;
  title: Rect | null;
  body: Rect;
}

export function frameGeometry(visual: Visual, rect: Rect, scale: number): FrameGeometry {
  const bare = BARE_TYPES.has(visual.type);
  const style = visual.options.style as VisualStyle | undefined;
  const showTitle = visual.title !== "" && !bare && style?.showTitle !== false;
  const pad = (typeof style?.padding === "number" ? style.padding : bare ? FRAME.barePad : FRAME.pad) * scale;
  const inner = inset(rect, pad);
  if (!showTitle) return { showTitle, title: null, body: inner };
  const th = FRAME.title * scale;
  return {
    showTitle,
    title: { ...inner, h: th },
    body: { ...inner, y: inner.y + th + FRAME.gap * scale, h: Math.max(0.05, inner.h - th - FRAME.gap * scale) },
  };
}

/** Construit les éléments d'un visuel : cadre, titre, corps (natif ou image). */
export function buildVisual(ctx: BuildContext): BuiltVisual {
  const { visual, def, theme, scale } = ctx;
  const style = visual.options.style as VisualStyle | undefined;
  const bare = BARE_TYPES.has(visual.type);
  const colors = visualColors(theme, style, bare);
  const geo = frameGeometry(visual, ctx.rect, scale);
  const title = visual.title || defaultTitle(visual);
  const items: SlideItem[] = [];
  const warnings: string[] = [];

  if (!bare && (colors.fill || colors.border || colors.shadow)) {
    items.push({
      kind: "shape",
      name: `Cadre — ${title}`,
      rect: ctx.rect,
      fill: colors.fill && { color: pptColor(colors.fill.color), transparency: colors.fill.transparency },
      line: colors.border && { color: pptColor(colors.border.color), width: colors.border.width * scale * 72 },
      radius: Math.min(colors.radius * scale, ctx.rect.w / 2, ctx.rect.h / 2),
      shadow: colors.shadow,
    });
  }
  if (geo.title) {
    items.push({
      kind: "text",
      name: `Titre — ${title}`,
      rect: geo.title,
      runs: [{ text: title }],
      fontSize: fontPt(colors.title.size, scale, 8),
      color: pptColor(colors.title.color),
      bold: colors.title.bold,
      align: colors.title.align,
      valign: "middle",
    });
  }

  const body = (): { items: SlideItem[]; native: boolean } => {
    if (def.query && !isReady(visual, def)) return { items: [message(ctx, geo.body, colors, "Visuel non configuré")], native: true };
    if (ctx.data.error) {
      warnings.push(`« ${title} » : ${ctx.data.error}`);
      return { items: [message(ctx, geo.body, colors, `Erreur : ${ctx.data.error}`)], native: true };
    }
    if (needsImage(visual, def, ctx.mode)) {
      if (ctx.image) return { items: [{ kind: "image", name: title, rect: geo.body, data: ctx.image }], native: false };
      warnings.push(`« ${title} » : capture impossible, visuel omis.`);
      return { items: [message(ctx, geo.body, colors, "Aperçu indisponible")], native: true };
    }
    if (ctx.data.result?.truncated) warnings.push(`« ${title} » : résultat tronqué (ajoutez un Top N ou des filtres).`);
    const builder = BUILDERS[visual.type];
    return { items: builder ? builder(ctx, geo.body, colors, title, warnings) : [], native: true };
  };
  const b = body();
  items.push(...b.items);
  return { items, native: b.native, warnings };
}

type Builder = (ctx: BuildContext, body: Rect, colors: VisualColors, title: string, warnings: string[]) => SlideItem[];

function message(ctx: BuildContext, body: Rect, colors: VisualColors, text: string): SlideItem {
  return {
    kind: "text",
    name: `Message — ${ctx.visual.id}`,
    rect: body,
    runs: [{ text }],
    fontSize: fontPt(12, ctx.scale, 8),
    color: pptColor(colors.muted),
    align: "center",
    valign: "middle",
  };
}

const num = (v: Scalar | undefined): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** Options communes : texte discret, quadrillage horizontal seul, fonds transparents. */
function chartBase(ctx: BuildContext, colors: VisualColors): Record<string, unknown> {
  const small = fontPt(11, ctx.scale, 8);
  const muted = pptColor(colors.muted);
  const none = { fill: { color: pptColor(colors.surface), transparency: 100 } };
  return {
    showTitle: false,
    chartArea: { ...none },
    plotArea: { ...none },
    catAxisLabelColor: muted,
    valAxisLabelColor: muted,
    catAxisLabelFontSize: small,
    valAxisLabelFontSize: small,
    catAxisLabelFontFace: "+mn-lt",
    valAxisLabelFontFace: "+mn-lt",
    catAxisLineShow: true,
    catAxisLineColor: pptColor(colors.grid),
    valAxisLineShow: false,
    valGridLine: { color: pptColor(colors.grid), size: 0.75 },
    catGridLine: { style: "none" },
    legendPos: "t",
    legendFontSize: small,
    legendFontFace: "+mn-lt",
    legendColor: pptColor(colors.fg),
    dataLabelColor: muted,
    dataLabelFontSize: fontPt(10, ctx.scale, 7),
    dataLabelFontFace: "+mn-lt",
  };
}

/** Histogramme, barres, courbes, aires, combiné : un seul axe de valeurs (jamais de double axe). */
const cartesian: Builder = (ctx, body, colors, title) => {
  const { visual, def } = ctx;
  if (!ctx.data.result) return [];
  const isCombo = visual.type === "combo";
  const shaped = shapeSeries(visual, ctx.data.result, ctx.dataset, isCombo ? ["values", "lines"] : ["values"], ctx.data.colors);
  if (!shaped.data.length) return [message(ctx, body, colors, "Aucune donnée pour ces filtres.")];

  const horizontal = visual.type === "bar";
  // PowerPoint trace la 1re catégorie en bas d'un graphique à barres : on inverse pour garder l'ordre de l'écran.
  const data = horizontal ? [...shaped.data].reverse() : shaped.data;
  // Comme à l'écran : libellés longs abrégés sous un axe horizontal (texte complet dans les barres horizontales).
  const labels = data.map((d) => (!horizontal && d.__label.length > 14 ? `${d.__label.slice(0, 13)}…` : d.__label));
  const series = shaped.series.map((s) => ({
    def: s,
    data: { name: s.label, labels, values: data.map((d) => num(d[s.key])) } satisfies ChartSeries,
    color: pptColor(resolveColor(s.color, colors)),
  }));

  const stacked = opt<boolean>(visual, def, "stacked") === true;
  const percent = opt<boolean>(visual, def, "percent") === true && visual.type !== "combo";
  const showLabels = opt<boolean>(visual, def, "labels") === true;
  const smooth = opt<boolean>(visual, def, "smooth") === true;
  const markers = opt<boolean>(visual, def, "markers") === true;
  const fmt = numberFormat(visual);
  const values = series.flatMap((s) => s.data.values);
  const grouping = percent ? "percentStacked" : stacked ? "stacked" : null;

  const base = chartBase(ctx, colors);
  const options: Record<string, unknown> = {
    ...base,
    objectName: title,
    showLegend: opt<boolean>(visual, def, "legend") !== false && series.length >= 2,
    valAxisLabelFormatCode: excelFormat(fmt, values, percent),
    dataLabelFormatCode: excelFormat({ ...fmt, compact: true }, values, false, "label"),
    // Étiquettes horizontales (PowerPoint saute celles qui se chevauchent) au lieu de l'inclinaison automatique.
    // 0,001° et non 0 : pptxgenjs n'écrit pas une rotation nulle, et PowerPoint inclinerait alors les libellés.
    catAxisLabelRotate: 0.001,
  };

  const barOptions = (list: typeof series): Record<string, unknown> => ({
    barDir: horizontal ? "bar" : "col",
    barGrouping: grouping ?? "clustered",
    barGapWidthPct: 70,
    chartColors: list.map((s) => s.color),
    showValue: showLabels && !percent,
    // Étiquettes au bout des barres ; au centre si empilé (« outEnd » corrompt un empilé).
    dataLabelPosition: grouping ? "ctr" : "outEnd",
  });
  const lineOptions = (list: typeof series): Record<string, unknown> => ({
    chartColors: list.map((s) => s.color),
    lineSize: 2,
    lineDataSymbol: markers ? "circle" : "none",
    lineDataSymbolSize: 6,
    lineDataSymbolLineColor: pptColor(colors.surface),
    lineSmooth: smooth,
    showValue: showLabels,
    dataLabelPosition: "t",
  });

  let layers: ChartLayer[];
  if (isCombo) {
    const bars = series.filter((s) => s.def.role === "values");
    const lines = series.filter((s) => s.def.role === "lines");
    layers = [
      ...(bars.length ? [{ type: "bar" as const, data: bars.map((s) => s.data), options: { ...barOptions(bars), barGrouping: stacked ? "stacked" : "clustered", dataLabelPosition: stacked ? "ctr" : "outEnd" } }] : []),
      ...(lines.length ? [{ type: "line" as const, data: lines.map((s) => s.data), options: lineOptions(lines) }] : []),
    ];
  } else if (visual.type === "line") {
    layers = [{ type: "line", data: series.map((s) => s.data), options: lineOptions(series) }];
  } else if (visual.type === "area") {
    layers = [
      {
        type: "area",
        data: series.map((s) => s.data),
        options: { chartColors: series.map((s) => s.color), barGrouping: grouping ?? "standard", chartColorsOpacity: grouping ? 85 : 35, showValue: false },
      },
    ];
  } else {
    layers = [{ type: "bar", data: series.map((s) => s.data), options: barOptions(series) }];
  }
  // Un seul calque : ses options sont celles du graphique.
  if (layers.length === 1 && layers[0]) {
    return [{ kind: "chart", name: title, rect: body, layers: [{ ...layers[0], options: {} }], options: { ...options, ...layers[0].options } }];
  }
  return [{ kind: "chart", name: title, rect: body, layers, options }];
};

/** Secteurs et anneau : 8 parts max puis « Autres », couleurs stables par valeur. */
const pie: Builder = (ctx, body, colors, title) => {
  const { visual, def } = ctx;
  const parts: Slice[] = slices(visual, ctx.data.result, ctx.dataset, true, ctx.data.colors);
  if (!parts.length) return [message(ctx, body, colors, "Aucune donnée pour ces filtres.")];
  const m = first(visual, "values");
  const donut = visual.type === "donut";
  return [
    {
      kind: "chart",
      name: title,
      rect: body,
      layers: [{ type: donut ? "doughnut" : "pie", data: [{ name: m ? bindingLabel(m) : "Valeur", labels: parts.map((p) => p.label), values: parts.map((p) => p.value) }], options: {} }],
      options: {
        ...chartBase(ctx, colors),
        objectName: title,
        chartColors: parts.map((p) => pptColor(resolveColor(p.color, colors))),
        showLegend: opt<boolean>(visual, def, "legend") !== false && parts.length >= 2,
        showPercent: opt<boolean>(visual, def, "labels") === true,
        showValue: false,
        dataLabelPosition: "bestFit",
        dataLabelColor: pptColor(colors.fg),
        holeSize: donut ? 58 : undefined,
        firstSliceAng: 0,
        dataBorder: { pt: 1.5, color: pptColor(colors.surface) },
      },
    },
  ];
};

/** Radar : une série par mesure (3 max, comme à l'écran). */
const radar: Builder = (ctx, body, colors, title) => {
  const { visual } = ctx;
  const cat = first(visual, "category");
  const measures = role(visual, "values").slice(0, 3);
  const result = ctx.data.result;
  if (!result || !cat || !measures.length) return [];
  const type = columnType(ctx.dataset, cat.field);
  const labels = result.rows.map((r) => formatDimension(r[bindingKey(cat)] ?? null, type, cat.bin));
  return [
    {
      kind: "chart",
      name: title,
      rect: body,
      layers: [{ type: "radar", data: measures.map((m) => ({ name: bindingLabel(m), labels, values: result.rows.map((r) => num(r[bindingKey(m)])) })), options: {} }],
      options: {
        ...chartBase(ctx, colors),
        objectName: title,
        chartColors: measures.map((_, i) => pptColor(colors.series[i] ?? colors.fg)),
        showLegend: measures.length >= 2,
        radarStyle: "marker",
        lineSize: 2,
        // Comme à l'écran : pas de graduations sur l'axe radial.
        valAxisHidden: true,
        valAxisLabelFormatCode: excelFormat({ ...numberFormat(visual), compact: true }, result.rows.flatMap((r) => measures.map((m) => num(r[bindingKey(m)])))),
      },
    },
  ];
};

/** Nuage de points sans légende (avec légende : image, PowerPoint partage l'axe X entre séries). */
const scatter: Builder = (ctx, body, colors, title) => {
  const { visual } = ctx;
  const result = ctx.data.result;
  const x = first(visual, "x");
  const y = first(visual, "y");
  const size = first(visual, "size");
  if (!result || !x || !y) return [];
  const rows = result.rows.filter((r) => r[bindingKey(x)] != null && r[bindingKey(y)] != null);
  if (!rows.length) return [message(ctx, body, colors, "Aucune donnée pour ces filtres.")];
  const xs = rows.map((r) => num(r[bindingKey(x)]));
  const ys = rows.map((r) => num(r[bindingKey(y)]));
  const fmt = numberFormat(visual);
  const data: ChartSeries[] = [
    { name: bindingLabel(x), values: xs },
    { name: bindingLabel(y), values: ys, ...(size ? { sizes: rows.map((r) => Math.max(0, num(r[bindingKey(size)]))) } : {}) },
  ];
  return [
    {
      kind: "chart",
      name: title,
      rect: body,
      layers: [{ type: size ? "bubble" : "scatter", data, options: {} }],
      options: {
        ...chartBase(ctx, colors),
        objectName: title,
        chartColors: [pptColor(colors.series[0] ?? colors.fg)],
        chartColorsOpacity: 75,
        showLegend: false,
        lineSize: 0,
        lineDataSymbol: "circle",
        lineDataSymbolSize: 7,
        lineDataSymbolLineColor: pptColor(colors.surface),
        valGridLine: { color: pptColor(colors.grid), size: 0.75 },
        catGridLine: { color: pptColor(colors.grid), size: 0.75 },
        showCatAxisTitle: true,
        catAxisTitle: bindingLabel(x),
        catAxisTitleColor: pptColor(colors.muted),
        catAxisTitleFontSize: fontPt(11, ctx.scale, 8),
        showValAxisTitle: true,
        valAxisTitle: bindingLabel(y),
        valAxisTitleColor: pptColor(colors.muted),
        valAxisTitleFontSize: fontPt(11, ctx.scale, 8),
        valAxisLabelFormatCode: excelFormat({ ...fmt, compact: true }, ys),
        catAxisLabelFormatCode: excelFormat({ ...fmt, compact: true }, xs),
      },
    },
  ];
};

/** KPI : valeur héroïque, écart à la cible, mini-tendance (graphique natif sans axes). */
const kpi: Builder = (ctx, body, colors, title) => {
  const { visual, def } = ctx;
  const valueB = first(visual, "values");
  const targetB = first(visual, "target");
  const row = ctx.data.result?.rows[0];
  if (!valueB || !row) return [];
  const fmt = numberFormat(visual, valueB);
  const value = num(row[bindingKey(valueB)]);
  const target = targetB ? num(row[bindingKey(targetB)]) : null;
  const gap = kpiGap(value, target);
  const higherIsBetter = opt<boolean>(visual, def, "higherIsBetter") !== false;
  const good = gap === null ? null : higherIsBetter ? gap >= 0 : gap <= 0;
  const spark = ctx.data.trend?.rows.map((r) => num(r[bindingKey(valueB)])) ?? [];

  const items: SlideItem[] = [];
  const s = ctx.scale;
  const labelH = visual.title ? 0 : 16 * s;
  const sparkH = spark.length > 1 ? Math.min(40 * s, body.h * 0.3) : 0;
  const gapH = gap !== null ? 18 * s : 0;
  const valueH = Math.max(0.2, body.h - labelH - sparkH - gapH);
  // Valeur : clamp(24 px, 8 % de la largeur, 52 px) comme à l'écran, et bornée par la hauteur disponible.
  const valuePx = Math.max(24, Math.min(52, (body.w / s) * 0.08, (valueH / s) * 0.8));
  let y = body.y + Math.max(0, (body.h - labelH - sparkH - gapH - Math.min(valueH, valuePx * 1.25 * s)) / 2);
  if (labelH) {
    items.push({ kind: "text", name: `Libellé — ${title}`, rect: { ...body, y, h: labelH }, runs: [{ text: bindingLabel(valueB) }], fontSize: fontPt(12, s, 8), color: pptColor(colors.muted), valign: "bottom" });
    y += labelH;
  }
  const vh = Math.min(valueH, valuePx * 1.25 * s);
  items.push({
    kind: "text",
    name: `Valeur — ${title}`,
    rect: { ...body, y, h: vh },
    runs: [{ text: formatNumber(value, fmt) }],
    fontSize: fontPt(valuePx, s, 14),
    color: pptColor(colors.fg),
    bold: true,
    valign: "middle",
    shrink: true,
  });
  y += vh;
  if (gap !== null && target !== null) {
    const sign = gap >= 0 ? "▲ +" : "▼ ";
    items.push({
      kind: "text",
      name: `Écart — ${title}`,
      rect: { ...body, y, h: gapH },
      runs: [
        { text: `${sign}${gap.toFixed(1).replace(".", ",")} % `, options: { color: pptColor(good ? ctx.theme.positive : ctx.theme.negative) } },
        { text: `vs cible (${formatNumber(target, { ...fmt, compact: true })})`, options: { color: pptColor(colors.muted) } },
      ],
      fontSize: fontPt(12, s, 8),
      color: pptColor(colors.muted),
      valign: "middle",
    });
    y += gapH;
  }
  if (sparkH) {
    items.push({
      kind: "chart",
      name: `Tendance — ${title}`,
      rect: { ...body, y, h: sparkH },
      layers: [{ type: "area", data: [{ name: bindingLabel(valueB), labels: spark.map((_, i) => String(i + 1)), values: spark }], options: {} }],
      options: {
        ...chartBase(ctx, colors),
        objectName: `Tendance — ${title}`,
        chartColors: [pptColor(colors.series[0] ?? colors.fg)],
        chartColorsOpacity: 25,
        showLegend: false,
        catAxisHidden: true,
        valAxisHidden: true,
        valGridLine: { style: "none" },
        catAxisLineShow: false,
        layout: { x: 0, y: 0.05, w: 1, h: 0.95 },
      },
    });
  }
  return items;
};

/** Largeur moyenne d'un caractère (em) : prudente, pour que PowerPoint ne passe pas à la ligne. */
const CHAR_EM = 0.6;
/** Marges gauche + droite d'une cellule (pouces). */
const CELL_PAD = 9 / 72;

/**
 * Largeurs de colonnes (pouces) : le contenu des lignes ne doit jamais passer à la ligne (sinon la
 * table déborde du cadre) ; l'espace restant va aux en-têtes, puis est réparti au prorata.
 */
export function columnWidths(body: string[][], header: string[], total: number, fontSize: number): number[] {
  const n = Math.max(header.length, ...body.map((r) => r.length), 1);
  const charW = (fontSize * CHAR_EM) / 72;
  const need = Array.from({ length: n }, (_, j) => Math.max(3, ...body.map((r) => (r[j] ?? "").length)) * charW + CELL_PAD);
  const want = need.map((w, j) => Math.max(w, (header[j] ?? "").length * charW + CELL_PAD));
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  if (sum(want) <= total) return want.map((w) => w + ((total - sum(want)) * w) / sum(want));
  if (sum(need) <= total) {
    const extra = want.map((w, j) => w - (need[j] ?? 0));
    return need.map((w, j) => w + ((total - sum(need)) * (extra[j] ?? 0)) / (sum(extra) || 1));
  }
  return need.map((w) => (w * total) / sum(need));
}

/** Tronque un texte à la largeur d'une colonne. */
function fit(text: string, widthIn: number, fontSize: number): string {
  const max = Math.max(3, Math.floor((widthIn - CELL_PAD) * 72 / (fontSize * CHAR_EM)));
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Mise en forme conditionnelle d'une cellule exportée (couleurs hexadécimales). */
interface CellDecor {
  fill?: string;
  text?: string;
}

interface TableSpec {
  header: { text: string; align: "left" | "right"; colspan?: number }[][];
  body: { cells: string[]; bold?: boolean; decor?: (CellDecor | undefined)[] }[];
  total: string[] | null;
  numericFrom: number;
}

/** Table PowerPoint : en-têtes discrets, filets horizontaux, lignes au-delà de la hauteur résumées. */
function tableItems(ctx: BuildContext, body: Rect, colors: VisualColors, title: string, spec: TableSpec, warnings: string[] = []): SlideItem[] {
  const fontSize = fontPt(12, ctx.scale, 7);
  const rowH = (fontSize * 1.3 + 5) / 72;
  const capacity = Math.max(1, Math.floor(body.h / rowH) - spec.header.length - (spec.total ? 1 : 0));
  let shown = spec.body;
  let more = 0;
  if (spec.body.length > capacity) {
    shown = spec.body.slice(0, Math.max(1, capacity - 1));
    more = spec.body.length - shown.length;
  }
  const leafHeader = spec.header[spec.header.length - 1] ?? [];
  const widths = columnWidths([...shown.map((r) => r.cells), ...(spec.total ? [spec.total] : [])], leafHeader.map((h) => h.text), body.w, fontSize);
  const line = { pt: 0.75, color: pptColor(colors.grid) };
  const noLine = { type: "none" as const };
  const fg = pptColor(colors.fg);
  const muted = pptColor(colors.muted);
  const cell = (text: string, j: number, o: Record<string, unknown> = {}): TableCell => ({
    // Cellule fusionnée (colspan) : largeur des colonnes couvertes.
    text: fit(text, widths.slice(j, j + Number(o.colspan ?? 1)).reduce((a, b) => a + b, 0) || 1, fontSize),
    options: { align: j >= spec.numericFrom ? "right" : "left", color: fg, border: [noLine, noLine, line, noLine], ...o },
  });

  const rows: TableCell[][] = [];
  for (const headerRow of spec.header) {
    let j = 0;
    rows.push(
      headerRow.map((h) => {
        const c = cell(h.text, j, { color: muted, align: h.align, ...(h.colspan && h.colspan > 1 ? { colspan: h.colspan } : {}) });
        j += h.colspan ?? 1;
        return c;
      }),
    );
  }
  for (const r of shown)
    rows.push(
      r.cells.map((t, j) => {
        const d = r.decor?.[j];
        return cell(t, j, {
          ...(r.bold ? { bold: true } : {}),
          ...(d?.fill ? { fill: { color: pptColor(d.fill) } } : {}),
          ...(d?.text ? { color: pptColor(d.text) } : {}),
        });
      }),
    );
  if (more > 0) {
    const n = leafHeader.length || 1;
    rows.push([cell(`… et ${more} autre${more > 1 ? "s" : ""} ligne${more > 1 ? "s" : ""} (voir le rapport)`, 0, { color: muted, colspan: n, align: "left", italic: true })]);
    warnings.push(`« ${title} » : ${more} ligne(s) au-delà de la hauteur du visuel non exportée(s).`);
  }
  if (spec.total) rows.push(spec.total.map((t, j) => cell(t, j, { bold: true, border: [line, noLine, noLine, noLine] })));

  return [
    {
      kind: "table",
      name: title,
      rect: body,
      rows,
      options: { colW: widths, rowH, fontSize, margin: [1.5, 4, 1.5, 4], valign: "middle", autoPage: false },
    },
  ];
}

const table: Builder = (ctx, body, colors, title, warnings) => {
  const { visual, def } = ctx;
  const result = ctx.data.result;
  if (!result) return [];
  const dims = role(visual, "columns");
  const measures = role(visual, "values");
  if (!result.rows.length) return [message(ctx, body, colors, "Aucune donnée pour ces filtres.")];
  const showTotals = opt<boolean>(visual, def, "totals") !== false && measures.length > 0;
  const totals = measures.map((m) =>
    (m.agg === "sum" || m.agg === "count") && !m.show ? formatNumber(result.rows.reduce((t, r) => t + num(r[bindingKey(m)]), 0), numberFormat(visual, m)) : "",
  );
  const cond = condExport(ctx, colors, measures.map(bindingKey), (key) => result.rows.map((r) => r[key] as number | null));
  return tableItems(ctx, body, colors, title, {
    header: [[...dims.map((d) => ({ text: bindingLabel(d), align: "left" as const })), ...measures.map((m) => ({ text: bindingLabel(m), align: "right" as const }))]],
    body: result.rows.map((r) => {
      const styled = measures.map((m) => cond(bindingKey(m), r[bindingKey(m)] ?? null, formatNumber(r[bindingKey(m)] ?? null, numberFormat(visual, m))));
      return {
        cells: [...dims.map((d) => formatDimension(r[bindingKey(d)] ?? null, columnType(ctx.dataset, d.field), d.bin)), ...styled.map((s) => s.text)],
        decor: [...dims.map(() => undefined), ...styled.map((s) => s.decor)],
      };
    }),
    total: showTotals ? [...dims.map((_, i) => (i === 0 ? "Total" : "")), ...totals] : null,
    numericFrom: dims.length,
  }, warnings);
};

/**
 * Mise en forme conditionnelle à l'export : fond et texte en hexadécimal (thème clair ou sombre),
 * icône ▲ ● ▼ devant la valeur. Les barres de données n'existent pas dans une table PowerPoint.
 */
function condExport(
  ctx: BuildContext,
  colors: VisualColors,
  keys: string[],
  valuesOf: (key: string) => (number | null)[],
): (key: string, raw: unknown, text: string) => { text: string; decor: CellDecor | undefined } {
  const formats = new Map<string, CondFormat>(keys.map((k) => [k, formatFor(ctx.visual, k)]));
  const stats = new Map<string, Stats | null>(keys.filter((k) => isFormatted(formats.get(k) as CondFormat)).map((k) => [k, statsOf(valuesOf(k))]));
  const palette = SCALES[ctx.theme.mode];
  return (key, raw, text) => {
    const f = formats.get(key);
    if (!f || !isFormatted(f) || typeof raw !== "number" || !text) return { text, decor: undefined };
    const d = decorate(raw, f, stats.get(key) ?? null);
    const hex = decorHex(d, palette, colors.surface);
    return { text: d.icon ? `${GLYPHS[d.icon.glyph]} ${text}` : text, decor: hex.fill || hex.text ? { fill: hex.fill, text: hex.text } : undefined };
  };
}

/** Nombre maximal de colonnes de valeurs d'une matrice exportée (au-delà : colonnes omises, Total conservé). */
export const MATRIX_MAX_VALUE_COLUMNS = 12;

const matrix: Builder = (ctx, body, colors, title, warnings) => {
  const { visual, def } = ctx;
  const result = ctx.data.result;
  if (!result) return [];
  const rows = role(visual, "rows");
  const column = first(visual, "columns");
  const values = role(visual, "values");
  const model = buildMatrix(result.rows, rows, column);
  if (!model.root.children.length && !model.root.cells.size) return [message(ctx, body, colors, "Aucune donnée pour ces filtres.")];
  const expandAll = opt<boolean>(visual, def, "expanded") === true;
  const colType = columnType(ctx.dataset, column?.field);

  const per = Math.max(1, values.length);
  const maxCols = Math.max(1, Math.floor(MATRIX_MAX_VALUE_COLUMNS / per) - 1);
  const kept = model.columns.slice(0, maxCols);
  if (kept.length < model.columns.length) warnings.push(`« ${title} » : ${model.columns.length - kept.length} colonne(s) omise(s), le total est conservé.`);
  const colKeys = [...kept.map(valueKey), "__total"];
  const colLabel = (k: string, i: number) => (k === "__total" ? "Total" : formatDimension(kept[i] ?? null, colType, column?.bin));

  const header: TableSpec["header"] = [
    [
      { text: rows.map(bindingLabel).join(" › "), align: "left" },
      ...colKeys.map((k, i) => ({
        text: column ? colLabel(k, i) : values.length === 1 && values[0] ? bindingLabel(values[0]) : "Valeurs",
        align: "right" as const,
        colspan: per,
      })),
    ],
  ];
  if (values.length > 1) header.push([{ text: "", align: "left" }, ...colKeys.flatMap(() => values.map((m) => ({ text: bindingLabel(m), align: "right" as const })))]);

  const cellsOf = (node: MatrixNode) => colKeys.flatMap((ck) => values.map((m) => (node.cells.get(ck) ? formatNumber(node.cells.get(ck)?.[bindingKey(m)] ?? null, numberFormat(visual, m)) : "")));
  // Lignes affichées (comme à l'écran), puis mise en forme conditionnelle sur leurs cellules hors Total.
  const visible: MatrixNode[] = [];
  const collect = (node: MatrixNode) => {
    visible.push(node);
    if (node.level < rows.length && expandAll) node.children.forEach(collect);
  };
  model.root.children.forEach(collect);
  const valueCols = colKeys.filter((k) => k !== "__total");
  const cond = condExport(ctx, colors, values.map(bindingKey), (key) => visible.flatMap((n) => valueCols.map((k) => n.cells.get(k)?.[key] as number | null)));
  const flat: TableSpec["body"] = visible.map((node) => {
    const binding = rows[node.level - 1];
    const isLeaf = node.level >= rows.length;
    const label = binding ? formatDimension(node.value, columnType(ctx.dataset, binding.field), binding.bin) : "";
    const styled = colKeys.flatMap((ck) =>
      values.map((m) => {
        const raw = node.cells.get(ck)?.[bindingKey(m)] ?? null;
        const text = node.cells.get(ck) ? formatNumber(raw, numberFormat(visual, m)) : "";
        return ck === "__total" ? { text, decor: undefined } : cond(bindingKey(m), raw, text);
      }),
    );
    return { cells: [`${" ".repeat(node.level - 1)}${label}`, ...styled.map((s) => s.text)], bold: !isLeaf, decor: [undefined, ...styled.map((s) => s.decor)] };
  });

  return tableItems(ctx, body, colors, title, { header, body: flat, total: ["Total", ...cellsOf(model.root)], numericFrom: 1 }, warnings);
};

/** Segment : le champ et la sélection enregistrée dans le rapport. */
const slicer: Builder = (ctx, body, colors, title) => {
  const { visual } = ctx;
  const field = first(visual, "field");
  if (!field) return [];
  const type = columnType(ctx.dataset, field.field);
  const f = slicerFilter(visual);
  let selection = "Tout";
  if (f?.op === "between") {
    const [a, b] = f.values;
    const show = (v: Scalar | undefined) => (v == null ? "…" : formatDimension(v, type, field.bin));
    selection = `de ${show(a)} à ${show(b)}`;
  } else if (f) {
    selection = f.values.map((v) => formatDimension(v, type, field.bin)).join(", ");
  }
  const runs: TextRun[] = [
    ...(ctx.visual.title === "" || !frameGeometry(visual, ctx.rect, ctx.scale).showTitle
      ? [{ text: bindingLabel(field), options: { color: pptColor(colors.muted), breakLine: true } }]
      : []),
    { text: selection, options: { bold: f !== null, color: pptColor(colors.fg) } },
  ];
  return [{ kind: "text", name: title, rect: body, runs, fontSize: fontPt(13, ctx.scale, 8), color: pptColor(colors.fg), valign: "top", shrink: true }];
};

/** Texte riche (gras **…**, puces « - ») en runs PowerPoint. */
export function richTextRuns(text: string, color: string): TextRun[] {
  const lines = text.split("\n");
  const runs: TextRun[] = [];
  lines.forEach((line, i) => {
    const bullet = /^\s*[-*•]\s+/.exec(line);
    const content = bullet ? line.slice(bullet[0].length) : line;
    const parts = content.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter((p) => p !== "");
    if (!parts.length) parts.push("");
    parts.forEach((part, j) => {
      const bold = part.startsWith("**") && part.endsWith("**") && part.length > 4;
      const code = part.startsWith("`") && part.endsWith("`") && part.length > 2;
      const options: TextRun["options"] = { color };
      if (bold) options.bold = true;
      if (bullet && j === 0) options.bullet = { indent: 12 };
      if (j === parts.length - 1 && i < lines.length - 1) options.breakLine = true;
      runs.push({ text: bold ? part.slice(2, -2) : code ? part.slice(1, -1) : part, options });
    });
  });
  return runs;
}

const TEXT_SIZES: Record<string, number> = { sm: 12, md: 14, lg: 18, xl: 24 };

const text: Builder = (ctx, body, colors, title) => {
  const { visual, def } = ctx;
  const size = opt<string>(visual, def, "size") ?? "md";
  const align = (opt<string>(visual, def, "align") ?? "left") as "left" | "center" | "right";
  const content = opt<string>(visual, def, "text") ?? "";
  if (!content.trim()) return [];
  return [
    {
      kind: "text",
      name: title === def.label ? "Texte" : title,
      rect: body,
      runs: richTextRuns(content, pptColor(colors.fg)),
      fontSize: fontPt(TEXT_SIZES[size] ?? 14, ctx.scale, 8),
      color: pptColor(colors.fg),
      bold: size === "xl",
      align,
      valign: "top",
      shrink: true,
    },
  ];
};

/** Bouton : forme cliquable ; « Ouvrir une URL » et « Aller à une page » restent actifs en diaporama. */
const button: Builder = (ctx, body, colors) => {
  const { visual, def, theme } = ctx;
  const action = opt<ButtonAction>(visual, def, "action");
  const label = (opt<string>(visual, def, "label") ?? "").replace(/\*\*/g, "");
  const variant = opt<string>(visual, def, "variant") ?? "primary";
  let link: Link | undefined;
  if (action === "url") {
    const url = renderTemplate(opt<string>(visual, def, "url") ?? "", ctx.links);
    if (isSafeUrl(url)) link = { url };
  } else if (action === "page") {
    const target = opt<string>(visual, def, "targetPage");
    const slide = target ? ctx.links.slideOf(target) : undefined;
    if (slide) link = { slide };
  }
  // Hauteur d'un bouton à l'écran : au moins 36 px, centré dans son cadre.
  const h = Math.min(body.h, Math.max(36 * ctx.scale, body.h * 0.8));
  const rect = { ...body, y: body.y + (body.h - h) / 2, h };
  const accent = pptColor(theme.accent);
  return [
    {
      kind: "shape",
      name: `Bouton — ${label}`,
      rect,
      fill: variant === "primary" ? { color: accent, transparency: 0 } : variant === "secondary" ? { color: pptColor(colors.surface), transparency: 0 } : null,
      line: variant === "secondary" ? { color: pptColor(theme.border), width: 0.75 } : null,
      radius: Math.min(6 * ctx.scale, h / 2),
      shadow: false,
      text: {
        runs: [{ text: label }],
        fontSize: fontPt(14, ctx.scale, 8),
        color: variant === "primary" ? pptColor(theme.accentFg) : variant === "ghost" ? accent : pptColor(colors.fg),
        bold: true,
        align: "center",
      },
      link,
    },
  ];
};

const BUILDERS: Partial<Record<Visual["type"], Builder>> = {
  column: cartesian,
  bar: cartesian,
  line: cartesian,
  area: cartesian,
  combo: cartesian,
  pie,
  donut: pie,
  radar,
  scatter,
  kpi,
  table,
  matrix,
  slicer,
  text,
  button,
};
