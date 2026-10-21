import JSZip from "jszip";

import { presetFor, type ReportTheme } from "../theme/reportTheme";
import type { ColumnProfile, DatasetProfile } from "../types/dataset";
import type { Page, Visual } from "../types/report";
import { VISUALS } from "../visuals/registry";
import type { QueryResult } from "../visuals/useQueryResult";
import { type BuildContext, type VisualData, buildVisual, columnWidths, needsImage, richTextRuns } from "./buildVisual";
import { exportTheme, pptColor, resolveColor, resolveReportTheme, visualColors } from "./colors";
import type { SlideItem } from "./items";
import { REF_WIDTH, contentArea, fontPt, placeBand, splitPage } from "./layout";
import { describeFilter, fileNameFor, slideNotes } from "./notes";
import { excelFormat } from "./numberFormat";
import { planSlides } from "./exportReport";
import { addItems } from "./writer";

const col = (name: string, type: ColumnProfile["type"]): ColumnProfile => ({
  name,
  type,
  nulls: 0,
  distinct: 5,
  min: null,
  max: null,
  mean: null,
  top_values: [],
});

const dataset: DatasetProfile = {
  id: "abcdefabcdef",
  name: "ventes.csv",
  format: "csv",
  rows: 10,
  columns_count: 4,
  created_at: "2026-01-01T00:00:00Z",
  columns: [col("region", "string"), col("produit", "string"), col("ca", "number"), col("date", "date")],
  sample: [],
};

let n = 0;
const visual = (type: Visual["type"], roles: Visual["roles"], options: Visual["options"] = {}, layout = { x: 0, y: 0, w: 12, h: 14 }): Visual => ({
  id: `v${++n}`,
  type,
  title: null,
  layout,
  dataset_id: dataset.id,
  roles,
  options,
  filters: [],
});

const result = (rows: Record<string, string | number | null>[], truncated = false): QueryResult => ({
  columns: Object.keys(rows[0] ?? {}).map((key) => ({ key, field: key, role: "dimension" as const, type: "string" as const })),
  rows,
  truncated,
});

const light = exportTheme(presetFor("light") as ReportTheme);
const data = (r: QueryResult | null, extra: Partial<VisualData> = {}): VisualData => ({ result: r, error: null, colors: null, trend: null, ...extra });

function ctx(v: Visual, d: VisualData, extra: Partial<BuildContext> = {}): BuildContext {
  return {
    visual: v,
    def: VISUALS[v.type],
    dataset,
    data: d,
    rect: { x: 1, y: 1, w: 6, h: 3.5 },
    scale: 12.733 / REF_WIDTH,
    theme: light,
    mode: "native",
    links: { slideOf: (id) => (id === "p2" ? 3 : undefined), page: "Ventes", report: "Rapport", filters: [] },
    ...extra,
  };
}

const ofKind = <K extends SlideItem["kind"]>(items: SlideItem[], kind: K) => items.filter((i): i is Extract<SlideItem, { kind: K }> => i.kind === kind);

describe("géométrie", () => {
  it("garde une page courte sur une diapositive et coupe une page haute entre deux rangées", () => {
    const area = contentArea(true);
    const short = [visual("kpi", {}, {}, { x: 16, y: 16, w: 300, h: 150 }), visual("column", {}, {}, { x: 16, y: 182, w: 1248, h: 400 })];
    expect(splitPage(short, area, "split")).toHaveLength(1);

    const tall = Array.from({ length: 6 }, (_, i) => visual("column", {}, {}, { x: 16, y: 16 + i * 340, w: 1248, h: 320 }));
    const bands = splitPage(tall, area, "split");
    expect(bands.length).toBeGreaterThan(1);
    expect(bands.flatMap((b) => b.visuals)).toHaveLength(6);
    // Jamais de visuel coupé : chaque bande commence au haut d'un visuel.
    for (const b of bands) expect(b.visuals.some((v) => v.layout.y === b.top)).toBe(true);
    expect(splitPage(tall, area, "fit")).toHaveLength(1);
  });

  it("n'isole pas deux visuels côte à côte qui se chevauchent verticalement", () => {
    const area = contentArea(false);
    const a = visual("column", {}, {}, { x: 0, y: 0, w: 640, h: 700 });
    const b = visual("column", {}, {}, { x: 640, y: 240, w: 640, h: 700 });
    const c = visual("column", {}, {}, { x: 0, y: 960, w: 1280, h: 700 });
    const bands = splitPage([a, b, c], area, "split", REF_WIDTH, 1);
    expect(bands[0]?.visuals).toEqual([a, b]);
  });

  it("met une bande à l'échelle sans sortir de la zone utile, selon la largeur de la page", () => {
    const area = contentArea(true);
    const v = visual("column", {}, {}, { x: 16, y: 16, w: 1248, h: 1400 });
    const band = splitPage([v], area, "fit")[0]!;
    const r = placeBand(band, area).rect(v.layout);
    expect(r.y).toBeCloseTo(area.y);
    expect(r.y + r.h).toBeLessThanOrEqual(area.y + area.h + 1e-6);
    expect(r.x + r.w).toBeLessThanOrEqual(area.x + area.w + 1e-6);

    // Page 16:9 de 1280 px : la largeur de la page occupe celle de la zone utile.
    const wide = visual("column", {}, {}, { x: 0, y: 0, w: 1280, h: 200 });
    const p = placeBand(splitPage([wide], area, "fit", 1280)[0]!, area);
    expect(p.rect(wide.layout).w).toBeCloseTo(area.w);
    // Page étroite (960 px) : même échelle relative, centrée.
    const narrow = visual("column", {}, {}, { x: 0, y: 0, w: 960, h: 200 });
    const q = placeBand(splitPage([narrow], area, "fit", 960)[0]!, area);
    expect(q.rect(narrow.layout).w).toBeCloseTo(area.w);
    expect(fontPt(11, 0.01)).toBe(8);
    expect(fontPt(2, 0.01)).toBe(7);
  });

  it("exporte un ancien rapport (grille) comme dans le Studio", () => {
    const legacy: Page = { id: "p1", name: "A", visuals: [visual("kpi", {}, {}, { x: 0, y: 0, w: 24, h: 8 })], filters: [] };
    const plan = planSlides([legacy], { fit: "split", pageTitles: true, titleSlide: false });
    expect(plan.slides[0]?.band.visuals[0]?.layout).toEqual({ x: 4, y: 4, w: 1272, h: 184 });
  });

  it("numérote les diapositives et retrouve la première diapositive de chaque page", () => {
    const pages: Page[] = [
      { id: "p1", name: "A", visuals: [visual("kpi", {})], filters: [] },
      { id: "p2", name: "B", visuals: [], filters: [] },
    ];
    const plan = planSlides(pages, { fit: "split", pageTitles: true, titleSlide: true });
    expect(plan.slides).toHaveLength(2);
    expect(plan.firstSlide.get("p1")).toBe(2);
    expect(plan.firstSlide.get("p2")).toBe(3);
  });
});

describe("couleurs", () => {
  it("résout les variables CSS en hexadécimal PowerPoint (sans #)", () => {
    const c = visualColors(light, undefined);
    expect(resolveColor("var(--series-2)", c)).toBe("#eb6834");
    expect(resolveColor("var(--muted)", c)).toBe(light.muted);
    expect(pptColor("#2a78d6")).toBe("2A78D6");
    expect(pptColor("#abc")).toBe("AABBCC");
  });

  it("suit l'application quand le rapport n'a pas de thème, et lit un thème sombre", () => {
    expect(resolveReportTheme({}, "dark").mode).toBe("dark");
    expect(exportTheme(resolveReportTheme({ mode: "dark", page: "#101010" }, "light")).page).toBe("#101010");
  });

  it("applique les surcharges du visuel : fond, transparence, bordure, palette, encre lisible", () => {
    const c = visualColors(light, { background: "#111111", backgroundOpacity: 100, borderColor: "#ff0000", borderWidth: 2, palette: ["#00ff00"] });
    expect(c.fill).toEqual({ color: "#111111", transparency: 0 });
    expect(c.border).toEqual({ color: "#ff0000", width: 2 });
    expect(c.series[0]).toBe("#00ff00");
    expect(c.series[1]).toBe(light.series[1]);
    expect(c.fg).toBe("#f0efec"); // encre claire sur fond sombre
    expect(visualColors(light, { backgroundOpacity: 0 }).fill).toBeNull();
    expect(visualColors(light, { border: false }).border).toBeNull();
  });
});

describe("formats de nombres", () => {
  it("choisit les décimales comme à l'écran", () => {
    expect(excelFormat({}, [12, 1500])).toBe("#,##0");
    expect(excelFormat({}, [0.25, 0.5])).toBe("#,##0.00");
    expect(excelFormat({ decimals: 1, suffix: " €" }, [1])).toBe('#,##0.0" €"');
  });

  it("compacte avec une seule unité pour toute la série", () => {
    expect(excelFormat({ compact: true }, [1200, 4_400_000])).toBe('#,##0.0,," M"');
    expect(excelFormat({ compact: true }, [12_000, 45_000])).toBe('#,##0," k"');
    expect(excelFormat({ compact: true }, [-3_000_000_000])).toBe('#,##0.0,,," Md"');
    expect(excelFormat({ compact: true }, [12, 800])).toBe("#,##0");
    expect(excelFormat({}, [0.5], true)).toBe("0%");
  });
});

describe("visuels natifs", () => {
  it("histogramme : séries, couleurs du thème, format, légende dès 2 séries", () => {
    const v = visual("column", { category: [{ field: "region" }], values: [{ field: "ca", agg: "sum" }, { field: "ca", agg: "avg" }] }, { compact: true });
    const built = buildVisual(ctx(v, data(result([{ region: "Nord", "sum(ca)": 12000, "avg(ca)": 300 }, { region: "Sud", "sum(ca)": 8000, "avg(ca)": 250 }]))));
    expect(built.native).toBe(true);
    const [chart] = ofKind(built.items, "chart");
    expect(chart?.layers[0]?.type).toBe("bar");
    expect(chart?.layers[0]?.data[0]).toMatchObject({ name: "Somme de ca", labels: ["Nord", "Sud"], values: [12000, 8000] });
    expect(chart?.options).toMatchObject({ barDir: "col", barGrouping: "clustered", showLegend: true, chartColors: ["2A78D6", "EB6834"] });
    expect(chart?.options.valAxisLabelFormatCode).toBe('#,##0," k"');
    // Cadre + titre automatique.
    expect(ofKind(built.items, "shape")[0]?.fill).toEqual({ color: "FCFCFB", transparency: 0 });
    expect(ofKind(built.items, "text")[0]?.runs[0]?.text).toBe("ca, Moyenne de ca par region");
  });

  it("barres horizontales : ordre inversé pour garder le haut du classement en haut", () => {
    const v = visual("bar", { category: [{ field: "region" }], values: [{ field: "ca", agg: "sum" }] });
    const built = buildVisual(ctx(v, data(result([{ region: "A", "sum(ca)": 3 }, { region: "B", "sum(ca)": 2 }, { region: "C", "sum(ca)": 1 }]))));
    const [chart] = ofKind(built.items, "chart");
    expect(chart?.layers[0]?.data[0]?.labels).toEqual(["C", "B", "A"]);
    expect(chart?.options).toMatchObject({ barDir: "bar", showLegend: false });
  });

  it("empilé : étiquettes au centre (outEnd corromprait le fichier)", () => {
    const v = visual("column", { category: [{ field: "region" }], series: [{ field: "produit" }], values: [{ field: "ca", agg: "sum" }] }, { stacked: true, labels: true });
    const rows = [
      { region: "Nord", produit: "A", "sum(ca)": 5 },
      { region: "Nord", produit: "B", "sum(ca)": 3 },
    ];
    const [chart] = ofKind(buildVisual(ctx(v, data(result(rows)))).items, "chart");
    expect(chart?.options).toMatchObject({ barGrouping: "stacked", dataLabelPosition: "ctr", showValue: true });
  });

  it("combiné : barres et courbes sur le même axe", () => {
    const v = visual("combo", { category: [{ field: "region" }], values: [{ field: "ca", agg: "sum" }], lines: [{ field: "ca", agg: "avg" }] });
    const [chart] = ofKind(buildVisual(ctx(v, data(result([{ region: "Nord", "sum(ca)": 5, "avg(ca)": 2 }])))).items, "chart");
    expect(chart?.layers.map((l) => l.type)).toEqual(["bar", "line"]);
    expect(JSON.stringify(chart)).not.toContain("secondaryValAxis");
  });

  it("anneau : parts triées, 8 max puis « Autres »", () => {
    const v = visual("donut", { category: [{ field: "produit" }], values: [{ field: "ca", agg: "sum" }] });
    const rows = Array.from({ length: 10 }, (_, i) => ({ produit: `P${i}`, "sum(ca)": 100 - i }));
    const [chart] = ofKind(buildVisual(ctx(v, data(result(rows)))).items, "chart");
    expect(chart?.layers[0]?.type).toBe("doughnut");
    expect(chart?.layers[0]?.data[0]?.labels).toHaveLength(8);
    expect(chart?.layers[0]?.data[0]?.labels?.at(-1)).toBe("Autres");
    expect(chart?.options.holeSize).toBe(58);
  });

  it("KPI : valeur formatée, écart coloré selon le sens", () => {
    const v = visual("kpi", { values: [{ field: "ca", agg: "sum" }], target: [{ field: "ca", agg: "max" }] }, { higherIsBetter: true });
    const built = buildVisual(ctx(v, data(result([{ "sum(ca)": 1100, "max(ca)": 1000 }]))));
    const texts = ofKind(built.items, "text");
    expect(texts.some((t) => t.runs[0]?.text === "1 100")).toBe(true);
    const gap = texts.find((t) => t.name.startsWith("Écart"));
    expect(gap?.runs[0]?.text).toContain("+10,0 %");
    expect(gap?.runs[0]?.options?.color).toBe(pptColor(light.positive));
  });

  it("table et matrice : mise en forme conditionnelle exportée (fond, texte, icônes)", () => {
    const conditional = { "sum(ca)": { scale: "sequential", icons: "sign", rules: [{ op: "lt", value: 0, color: "negative" }], rulesTarget: "text" } };
    const v = visual("table", { columns: [{ field: "region" }], values: [{ field: "ca", agg: "sum" }] }, { conditional });
    const rows = [
      { region: "Nord", "sum(ca)": 100 },
      { region: "Sud", "sum(ca)": -20 },
      { region: "Est", "sum(ca)": 40 },
    ];
    const [table] = ofKind(buildVisual(ctx(v, data(result(rows)))).items, "table");
    const body = table?.rows.slice(1, 4) ?? [];
    expect(body.map((r) => r[1]?.text.slice(0, 1))).toEqual(["▲", "▼", "▲"]);
    const fills = body.map((r) => (r[1]?.options?.fill as { color: string } | undefined)?.color);
    expect(fills.every((f) => typeof f === "string" && /^[0-9A-F]{6}$/i.test(f))).toBe(true);
    expect(new Set(fills).size).toBe(3); // intensités différentes
    expect(body[1]?.[1]?.options?.color).toBe("D03B3B"); // règle « < 0 » en rouge sur le texte
    expect(body[0]?.[0]?.options?.fill).toBeUndefined(); // dimensions jamais colorées

    const m = visual("matrix", { rows: [{ field: "region" }], columns: [{ field: "produit" }], values: [{ field: "ca", agg: "sum" }] }, { conditional: { "sum(ca)": { scale: "diverging" } } });
    const mrows = [
      { region: "Nord", produit: "A", "sum(ca)": 10 },
      { region: "Nord", produit: "B", "sum(ca)": -10 },
      { region: "Nord", produit: null, "sum(ca)": 0 },
      { region: null, produit: "A", "sum(ca)": 10 },
      { region: null, produit: "B", "sum(ca)": -10 },
      { region: null, produit: null, "sum(ca)": 0 },
    ];
    const [mt] = ofKind(buildVisual(ctx(m, data(result(mrows)))).items, "table");
    const nord = mt?.rows.find((r) => r[0]?.text === "Nord");
    expect(nord?.[1]?.options?.fill).toBeDefined();
    expect(nord?.[3]?.options?.fill).toBeUndefined(); // colonne Total jamais colorée
  });

  it("table : total, et lignes au-delà de la hauteur résumées", () => {
    const v = visual("table", { columns: [{ field: "region" }], values: [{ field: "ca", agg: "sum" }] });
    const rows = Array.from({ length: 80 }, (_, i) => ({ region: `R${i}`, "sum(ca)": i }));
    const built = buildVisual(ctx(v, data(result(rows))));
    const [table] = ofKind(built.items, "table");
    const last = table?.rows.at(-1);
    expect(last?.[0]?.text).toBe("Total");
    expect(last?.[1]?.text).toBe("3 160");
    expect(table?.rows.some((r) => r[0]?.text.startsWith("… et "))).toBe(true);
    expect(built.warnings[0]).toContain("non exportée");
  });

  it("matrice : premier niveau seulement si repliée, Total en dernière ligne", () => {
    const v = visual("matrix", { rows: [{ field: "region" }, { field: "produit" }], values: [{ field: "ca", agg: "sum" }] });
    const rows = [
      { region: null, produit: null, "sum(ca)": 10, __grouping: 3 },
      { region: "Nord", produit: null, "sum(ca)": 6, __grouping: 1 },
      { region: "Nord", produit: "A", "sum(ca)": 6, __grouping: 0 },
      { region: "Sud", produit: null, "sum(ca)": 4, __grouping: 1 },
    ];
    const [table] = ofKind(buildVisual(ctx(v, data(result(rows)))).items, "table");
    expect(table?.rows.map((r) => r[0]?.text)).toEqual(["region › produit", "Nord", "Sud", "Total"]);
    const expanded = visual("matrix", v.roles, { expanded: true });
    const [t2] = ofKind(buildVisual(ctx(expanded, data(result(rows)))).items, "table");
    expect(t2?.rows.map((r) => r[0]?.text)).toContain(" A");
  });

  it("texte riche et bouton cliquable", () => {
    const runs = richTextRuns("**Titre**\n- un\n- deux", "000000");
    expect(runs[0]).toMatchObject({ text: "Titre", options: { bold: true, breakLine: true } });
    expect(runs[1]).toMatchObject({ text: "un", options: { bullet: { indent: 12 }, breakLine: true } });
    expect(runs[2]?.options?.breakLine).toBeUndefined();

    const url = visual("button", {}, { action: "url", url: "https://exemple.fr/{page}", label: "Ouvrir" });
    expect(ofKind(buildVisual(ctx(url, data(null))).items, "shape")[0]?.link).toEqual({ url: "https://exemple.fr/Ventes" });
    const page = visual("button", {}, { action: "page", targetPage: "p2", label: "Détail" });
    expect(ofKind(buildVisual(ctx(page, data(null))).items, "shape")[0]?.link).toEqual({ slide: 3 });
    const js = visual("button", {}, { action: "url", url: "javascript:alert(1)" });
    expect(ofKind(buildVisual(ctx(js, data(null))).items, "shape")[0]?.link).toBeUndefined();
  });

  it("image pour ce que PowerPoint ne trace pas, et pour tout en mode Images", () => {
    const map = visual("map", { location: [{ field: "region" }], values: [{ field: "ca", agg: "sum" }] });
    const col = visual("column", { category: [{ field: "region" }], values: [{ field: "ca", agg: "sum" }] });
    expect(needsImage(map, VISUALS.map, "native")).toBe(true);
    expect(needsImage(col, VISUALS.column, "native")).toBe(false);
    expect(needsImage(col, VISUALS.column, "image")).toBe(true);
    expect(needsImage(visual("text", {}), VISUALS.text, "image")).toBe(false);
    const built = buildVisual(ctx(map, data(result([{ region: "Bretagne", "sum(ca)": 1 }])), { image: "data:image/png;base64,AAAA" }));
    expect(built.native).toBe(false);
    expect(ofKind(built.items, "image")).toHaveLength(1);
  });

  it("répartit la largeur des colonnes selon le contenu", () => {
    const w = columnWidths([["Provence-Alpes-Côte d'Azur", "12"]], ["Région", "Chiffre d'affaires"], 4, 9);
    expect(w[0]! + w[1]!).toBeCloseTo(4);
    // Le contenu des lignes tient sans retour à la ligne : 26 caractères × 0,6 em × 9 pt.
    expect(w[0]!).toBeGreaterThanOrEqual((26 * 0.6 * 9) / 72);
    // Trop étroit : réduction proportionnelle (les cellules seront abrégées).
    const narrow = columnWidths([["Provence-Alpes-Côte d'Azur", "12 345"]], ["Région", "CA"], 1, 9);
    expect(narrow[0]! + narrow[1]!).toBeCloseTo(1);
  });
});

describe("notes et nom de fichier", () => {
  it("décrit les filtres en français", () => {
    expect(describeFilter({ field: "region", op: "in", values: ["Nord", "Sud"] })).toBe("region : Nord, Sud");
    expect(describeFilter({ field: "ca", op: "gte", values: [1000] }, dataset)).toBe("ca ≥ 1 000");
    expect(describeFilter({ field: "date", op: "between", values: ["2026-01-01", null] }, dataset)).toBe("date : de 01/01/2026 à …");
  });

  it("liste filtres de page, segments et source dans les notes", () => {
    const slicer = visual("slicer", { field: [{ field: "produit" }] }, { selected: ["A"] });
    const page: Page = { id: "p1", name: "Ventes", visuals: [slicer], filters: [{ field: "region", op: "in", values: ["Nord"] }] };
    const notes = slideNotes(page, null, new Map([[dataset.id, dataset]]), new Date(2026, 9, 19));
    expect(notes).toContain("Filtres de la page : region : Nord");
    expect(notes).toContain("Segments : produit : A");
    expect(notes).toContain("Source : ventes.csv");
    expect(notes).toContain("19 octobre 2026");
  });

  it("produit un nom de fichier valide sous Windows", () => {
    expect(fileNameFor('Ventes: T1/T2 "2026"')).toBe("Ventes T1 T2 2026.pptx");
    expect(fileNameFor("   ")).toBe("Rapport.pptx");
  });
});

describe("écriture pptxgenjs", () => {
  it("produit un .pptx avec graphique natif, table, lien et image", async () => {
    const { default: PptxGenJS } = await import("pptxgenjs");
    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_WIDE";
    const slide = pptx.addSlide();
    const col = visual("column", { category: [{ field: "region" }], values: [{ field: "ca", agg: "sum" }] });
    const combo = visual("combo", { category: [{ field: "region" }], values: [{ field: "ca", agg: "sum" }], lines: [{ field: "ca", agg: "avg" }] });
    const tbl = visual("table", { columns: [{ field: "region" }], values: [{ field: "ca", agg: "sum" }] });
    const btn = visual("button", {}, { action: "url", url: "https://exemple.fr", label: "Ouvrir" });
    const map = visual("map", { location: [{ field: "region" }], values: [{ field: "ca", agg: "sum" }] });
    const r = result([{ region: "Nord & Est", "sum(ca)": 5, "avg(ca)": 2 }]);
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    for (const v of [col, combo, tbl, btn, map]) addItems(pptx, slide, buildVisual(ctx(v, data(r), { image: png })).items);
    const buffer = (await pptx.write({ outputType: "arraybuffer" })) as ArrayBuffer;
    const zip = await JSZip.loadAsync(buffer);
    const files = Object.keys(zip.files);
    expect(files.filter((f) => /^ppt\/charts\/chart\d+\.xml$/.test(f))).toHaveLength(2);
    expect(files.some((f) => f.startsWith("ppt/media/"))).toBe(true);
    const xml = await zip.file("ppt/slides/slide1.xml")!.async("string");
    expect(xml).toContain("<a:tbl>");
    expect(xml).toContain("Nord &amp; Est");
    const rels = await zip.file("ppt/slides/_rels/slide1.xml.rels")!.async("string");
    expect(rels).toContain("https://exemple.fr");
    expect(xml).not.toMatch(/srgbClr val="#/);
  });
});
