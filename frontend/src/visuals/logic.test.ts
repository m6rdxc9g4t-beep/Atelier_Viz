import { slicerFilter, visualFilters } from "../studio/filters";
import { starterPages } from "../studio/starter";
import { bestRole, bindInto, convertRoles, newVisual } from "../studio/store";
import type { ColumnProfile, DatasetProfile } from "../types/dataset";
import type { Page, Visual } from "../types/report";
import { genericQuery } from "./common";
import { matrixQuery, buildMatrix } from "./data/pivot";
import { bindingKey, bindingLabel } from "./fields";
import { formatDimension, formatNumber } from "./format";
import { isSafeUrl, renderTemplate } from "./interactive/actions";
import { aliasOf, featureKeys } from "./maps/geo";
import { VISUALS } from "./registry";

const col = (name: string, type: ColumnProfile["type"], distinct = 5): ColumnProfile => ({
  name,
  type,
  nulls: 0,
  distinct,
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
  columns_count: 5,
  created_at: "2026-10-19T00:00:00Z",
  columns: [col("date", "date"), col("region", "string"), col("produit", "string", 4), col("ca", "number"), col("latitude", "number")],
  sample: [],
};

const visual = (type: Visual["type"], roles: Visual["roles"] = {}, options = {}): Visual => ({
  id: `v-${type}`,
  type,
  title: null,
  layout: { x: 0, y: 0, w: 8, h: 8 },
  dataset_id: dataset.id,
  roles,
  options,
  filters: [],
});

describe("champs et formats", () => {
  it("produit les mêmes clés que le backend", () => {
    expect(bindingKey({ field: "ca", agg: "sum" })).toBe("sum(ca)");
    expect(bindingKey({ field: "date", bin: "month" })).toBe("date|month");
    expect(bindingLabel({ field: "ca", agg: "avg" })).toBe("Moyenne de ca");
  });

  it("formate à la française", () => {
    expect(formatNumber(1234567, { compact: true }).replace(/\s/g, " ")).toBe("1,2 M");
    expect(formatNumber(0.5, { suffix: " %" })).toBe("0,5 %");
    expect(formatDimension("2026-04-01", "date", "quarter")).toBe("T2 2026");
    expect(formatDimension("2026-04-01", "date", "month")).toBe("avr. 2026");
    expect(formatDimension(null, "string")).toBe("(Vide)");
  });
});

describe("requêtes des visuels", () => {
  it("attend les rôles obligatoires puis trie et limite", () => {
    expect(genericQuery(visual("column", { category: [{ field: "region" }] }), VISUALS.column, [])).toBeNull();
    const q = genericQuery(
      visual("bar", { category: [{ field: "region" }], values: [{ field: "ca", agg: "sum" }] }, { topN: 3 }),
      VISUALS.bar,
      [],
    );
    expect(q).toMatchObject({ dimensions: [{ field: "region" }], measures: [{ field: "ca", agg: "sum" }], sort: [{ key: "sum(ca)", desc: true }], limit: 3 });
  });

  it("construit les GROUPING SETS de la matrice et l'arbre des sous-totaux", () => {
    const rows = [{ field: "region" }, { field: "produit" }];
    const column = { field: "date", bin: "year" as const };
    const q = matrixQuery("ds", rows, column, [{ field: "ca", agg: "sum" }], []);
    expect(q.grouping_sets).toEqual([
      ["region", "produit", "date|year"],
      ["region", "produit"],
      ["region", "date|year"],
      ["region"],
      ["date|year"],
      [],
    ]);
    // bits : region=4, produit=2, date=1 (1 = agrégé)
    const model = buildMatrix(
      [
        { __grouping: 0, region: "Nord", produit: "A", "date|year": "2026-01-01", "sum(ca)": 10 },
        { __grouping: 1, region: "Nord", produit: "A", "date|year": null, "sum(ca)": 10 },
        { __grouping: 2, region: "Nord", produit: null, "date|year": "2026-01-01", "sum(ca)": 10 },
        { __grouping: 3, region: "Nord", produit: null, "date|year": null, "sum(ca)": 10 },
        { __grouping: 7, region: null, produit: null, "date|year": null, "sum(ca)": 10 },
      ],
      rows,
      column,
    );
    expect(model.columns).toEqual(["2026-01-01"]);
    const nord = model.root.children[0];
    expect(nord?.value).toBe("Nord");
    expect(nord?.cells.get("__total")?.["sum(ca)"]).toBe(10);
    expect(nord?.children[0]?.cells.size).toBe(2);
    expect(model.root.cells.get("__total")?.["sum(ca)"]).toBe(10);
  });
});

describe("filtres", () => {
  const slicer = visual("slicer", { field: [{ field: "region" }] }, { selected: ["Nord"] });
  const chart = visual("column", { category: [{ field: "produit" }], values: [{ field: "ca", agg: "sum" }] });
  const page: Page = { id: "p", name: "P", visuals: [slicer, chart], filters: [{ field: "ca", op: "gt", values: [0] }, { field: "inconnu", op: "in", values: ["x"] }] };
  const fieldsOf = () => new Set(dataset.columns.map((c) => c.name));

  it("combine page, segments, sélection et filtres du visuel", () => {
    const sel = { visualId: "autre", datasetId: dataset.id, keys: ["A"], filters: [{ field: "produit", op: "in" as const, values: ["A"] }] };
    const f = visualFilters(page, chart, sel, fieldsOf);
    expect(f.map((x) => x.field)).toEqual(["ca", "region", "produit"]);
  });

  it("un segment ne se filtre pas lui-même", () => {
    expect(visualFilters(page, slicer, null, fieldsOf).map((x) => x.field)).toEqual(["ca"]);
  });

  it("segment plage → between ; vide → aucun filtre", () => {
    expect(slicerFilter(visual("slicer", { field: [{ field: "ca" }] }, { style: "range", range: [10, null] }))).toEqual({
      field: "ca",
      op: "between",
      values: [10, null],
    });
    expect(slicerFilter(visual("slicer", { field: [{ field: "ca" }] }, { selected: [] }))).toBeNull();
  });
});

describe("boutons d'automatisation", () => {
  const ctx = { filters: [{ field: "region", op: "in" as const, values: ["Île-de-France", "Occitanie"] }], page: "Synthèse", report: "Ventes" };
  it("remplace les variables et encode l'URL", () => {
    expect(renderTemplate("https://x.fr/?r={region}&p={page}&z={absent}", ctx)).toBe(
      "https://x.fr/?r=%C3%8Ele-de-France%2COccitanie&p=Synth%C3%A8se&z=",
    );
  });
  it("refuse les schémas dangereux", () => {
    expect(isSafeUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeUrl("https://example.com")).toBe(true);
    expect(isSafeUrl("mailto:a@b.fr")).toBe(true);
  });
});

describe("édition", () => {
  it("place un champ dans le rôle adapté et respecte le maximum", () => {
    const v = visual("column");
    v.dataset_id = null;
    const ca = dataset.columns[3] as ColumnProfile;
    const region = dataset.columns[1] as ColumnProfile;
    expect(bestRole(v, ca)?.id).toBe("values");
    expect(bestRole(v, region)?.id).toBe("category");
    expect(bindInto(v, VISUALS.column.roles[0]!, region, dataset.id)).toBeNull();
    expect(bindInto(v, VISUALS.column.roles[0]!, dataset.columns[2] as ColumnProfile, dataset.id)).toBeNull();
    // Deux champs dans l'Axe : hiérarchie explorable (région → produit), 4 niveaux au plus.
    expect(v.roles.category).toEqual([{ field: "region" }, { field: "produit" }]);
    for (const c of dataset.columns) bindInto(v, VISUALS.column.roles[0]!, c, dataset.id);
    expect(v.roles.category).toHaveLength(4);
    expect(bindInto(v, VISUALS.column.roles[0]!, region, "autre-jeu")).toMatch(/un seul jeu/);
  });

  it("reconnaît latitude / longitude par leur nom", () => {
    expect(bestRole(visual("pointmap"), dataset.columns[4] as ColumnProfile)?.id).toBe("lat");
  });

  it("conserve les champs en changeant de type", () => {
    const v = visual("column", { category: [{ field: "region" }], series: [{ field: "produit" }], values: [{ field: "ca", agg: "sum" }] });
    expect(convertRoles(v, "table")).toEqual({ columns: [{ field: "region", agg: null }, { field: "produit", agg: null }], values: [{ field: "ca", agg: "sum" }] });
    expect(convertRoles(v, "pie")).toEqual({ category: [{ field: "region", agg: null }], values: [{ field: "ca", agg: "sum" }] });
  });

  it("place un nouveau visuel dans le premier espace libre de la page", () => {
    const kpi = { ...visual("kpi"), layout: { x: 16, y: 16, w: 300, h: 150 } };
    const page: Page = { id: "p", name: "P", visuals: [kpi], filters: [], size: { width: 1280, height: 720 } };
    // À droite du KPI, avec 16 px de marge.
    expect(newVisual("table", page, dataset.id).layout).toMatchObject({ x: 332, y: 16 });
  });

  it("génère un rapport de démarrage cohérent", () => {
    const pages = starterPages(dataset);
    // En pixels, dans une page 16:9 de 1280 px de large (allongée si besoin).
    for (const p of pages) {
      expect(p.size?.width).toBe(1280);
      for (const v of p.visuals) expect(v.layout.x + v.layout.w).toBeLessThanOrEqual(1280);
    }
    expect(pages.map((p) => p.name)).toEqual(["Vue d'ensemble", "Détail"]);
    const types = pages.flatMap((p) => p.visuals.map((v) => v.type));
    expect(types).toEqual(expect.arrayContaining(["kpi", "column", "map", "matrix", "table", "button", "slicer"]));
    for (const v of pages.flatMap((p) => p.visuals)) {
      for (const [roleId, bindings] of Object.entries(v.roles)) {
        expect(VISUALS[v.type].roles.some((r) => r.id === roleId)).toBe(true);
        for (const b of bindings) expect(dataset.columns.some((c) => c.name === b.field)).toBe(true);
      }
    }
  });
});

describe("registre et cartes", () => {
  it("chaque visuel a un composant, des rôles uniques et des options cohérentes", () => {
    expect(Object.keys(VISUALS)).toHaveLength(22);
    for (const def of Object.values(VISUALS)) {
      expect(def.component).toBeTypeOf("function");
      expect(new Set(def.roles.map((r) => r.id)).size).toBe(def.roles.length);
      if (def.roles.length) expect(def.query).toBeTypeOf("function");
    }
  });

  it("rapproche les noms géographiques sans accents et en français", () => {
    expect(featureKeys({ type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: { nom: "Île-de-France", code: "11" } })).toContain(
      aliasOf("ile de france"),
    );
    expect(aliasOf("Allemagne")).toBe("germany");
    expect(featureKeys({ type: "Feature", geometry: { type: "Point", coordinates: [0, 0] }, properties: { nom: "Ain", code: "01" } })).toContain("1");
  });
});

describe("couleurs stables", () => {
  it("la couleur suit la valeur, et au-delà de 8 valeurs le reste passe en « Autres »", async () => {
    const { colorDomain } = await import("./useStableColors");
    const d = colorDomain(["Logiciel", "Matériel", "Formation"]);
    expect(d.get("Logiciel")).toBe("var(--series-1)");
    expect(d.get("Formation")).toBe("var(--series-3)");
    const many = colorDomain(Array.from({ length: 10 }, (_, i) => `v${i}`));
    expect(many.get("v6")).toBe("var(--series-7)");
    expect(many.get("v7")).toBe("var(--muted)");
  });
});

describe("IA qui construit", () => {
  it("catalogue transmis à l'IA : visuels avec données, options utiles seulement", async () => {
    const { aiCatalog } = await import("./catalog");
    const cat = aiCatalog();
    expect(cat.map((c) => c.type)).not.toContain("button");
    expect(cat.map((c) => c.type)).toContain("map");
    const map = cat.find((c) => c.type === "map")!;
    expect(map.options.find((o) => o.key === "geo")?.choices).toEqual(["fr-regions", "fr-departements", "world"]);
    expect(cat.flatMap((c) => c.options.map((o) => o.key))).not.toContain("suffix");
  });

  it("place les nouveaux visuels sans chevauchement, puis sous le contenu quand la page est pleine", async () => {
    const { placeVisuals } = await import("../studio/placement");
    const kpi = { ...visual("kpi"), layout: { x: 16, y: 16, w: 300, h: 150 } };
    const page: Page = { id: "p", name: "P", visuals: [kpi], filters: [], size: { width: 1280, height: 720 } };
    const placed = placeVisuals(page, ["column", "map", "table", "matrix"]);
    // Tailles par défaut du registre (cases de grille) converties en px : 8 × 14 cases → 419 × 328.
    expect(placed[0]).toEqual({ x: 332, y: 16, w: 419, h: 328 });
    expect(placed[1]).toMatchObject({ x: 767, y: 16 });
    expect(placed[2]).toMatchObject({ x: 16, y: 360 });
    // Plus de place dans 720 px : sous le contenu (la page s'agrandira).
    expect(placed[3]).toMatchObject({ x: 16, y: 704 });
    const all = [kpi.layout, ...placed];
    for (const [i, a] of all.entries()) {
      expect(a.x + a.w).toBeLessThanOrEqual(1280);
      for (const b of all.slice(i + 1)) expect(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y).toBe(true);
    }
  });

  it("propose des demandes adaptées au jeu de données", async () => {
    const { suggestPrompts } = await import("../studio/panes/AIBuilderPane");
    const s = suggestPrompts(dataset);
    expect(s[0]).toBe("ca par region sur une carte");
    expect(s.some((x) => x.startsWith("Évolution mensuelle de ca"))).toBe(true);
  });
});
