import { beforeEach, describe, expect, it } from "vitest";

import type { DatasetProfile } from "../types/dataset";
import type { Page, Report, Visual } from "../types/report";
import { drillTargets, extractionLabel, fitScale, presentationPages, sameField, step } from "./extraction";
import { visualFilters } from "./filters";
import { useStudio } from "./store";

const page = (id: string, fields?: string[]): Page => ({
  id,
  name: `Page ${id}`,
  visuals: [],
  filters: [],
  size: { width: 1280, height: 720 },
  drillthrough: fields ? { fields } : null,
});
const report: Report = {
  id: "r",
  name: "R",
  dataset_id: null,
  theme: {},
  created_at: "",
  updated_at: "",
  pages: [page("synthese"), page("region", ["region"]), page("produit", ["produit", "magasins.ville"])],
} as Report;
const selection = (field: string, value: string, datasetId = "ventes") => ({ visualId: "v", datasetId, keys: [value], filters: [{ field, op: "in" as const, values: [value] }] });

describe("pages d'extraction", () => {
  it("trouve les pages qui acceptent les champs de l'élément", () => {
    expect(drillTargets(report, "synthese", selection("region", "Occitanie")).map((t) => t.page.id)).toEqual(["region"]);
    expect(drillTargets(report, "synthese", selection("ville", "Lyon")).map((t) => t.page.id)).toEqual(["produit"]);
    expect(drillTargets(report, "synthese", selection("regions.region", "Nord")).map((t) => t.page.id)).toEqual(["region"]);
    expect(drillTargets(report, "region", selection("region", "Nord"))).toEqual([]); // pas vers elle-même
    expect(drillTargets(report, "synthese", null)).toEqual([]);
    expect(sameField("region", "regionale")).toBe(false);
  });

  it("décrit les filtres reçus", () => {
    expect(extractionLabel([{ field: "region", op: "in", values: ["Occitanie"] }])).toBe("region = Occitanie");
    expect(extractionLabel([{ field: "date", op: "in", values: ["2026-03-01"], bin: "month" }, { field: "x", op: "in", values: [1, 2, 3, 4] }])).toBe(
      "date = mars 2026, x = 1 ou 2 ou 3…",
    );
  });

  it("applique les filtres d'extraction aux visuels de la page cible", () => {
    const col = (name: string) => ({ name, type: "string" as const, nulls: 0, distinct: 1, min: null, max: null, mean: null, top_values: [] });
    const base = { format: "csv" as const, rows: 1, columns_count: 1, created_at: "", sample: [] };
    const ventes: DatasetProfile = { ...base, id: "ventes", name: "ventes", columns: [col("region"), col("regions.code")], model: { columns: [], measures: [], relations: [{ name: "regions", dataset_id: "regions", from_column: "region", to_column: "region" }] } };
    const regions: DatasetProfile = { ...base, id: "regions", name: "regions", columns: [col("region"), col("code")] };
    const magasins: DatasetProfile = { ...base, id: "magasins", name: "magasins", columns: [col("ville"), col("region")] };
    const autre: DatasetProfile = { ...base, id: "autre", name: "autre", columns: [col("x")] };
    const all = new Map([ventes, regions, magasins, autre].map((p) => [p.id, p]));
    const v = (dataset: string): Visual => ({ id: `v-${dataset}`, type: "table", title: null, layout: { x: 0, y: 0, w: 100, h: 100 }, dataset_id: dataset, roles: {}, options: {}, filters: [] });
    const target = page("region", ["code"]);
    // Extraction depuis un visuel du jeu régions (code = N) : les ventes via la relation.
    const fromRegions = { datasetId: "regions", filters: [{ field: "code", op: "in" as const, values: ["N"] }] };
    expect(visualFilters(target, v("ventes"), null, (id) => all.get(id), fromRegions).map((f) => f.field)).toEqual(["regions.code"]);
    // Depuis les ventes (region = Nord) : même jeu, et magasins par une colonne de même nom.
    const fromVentes = { datasetId: "ventes", filters: [{ field: "region", op: "in" as const, values: ["Nord"] }] };
    expect(visualFilters(target, v("ventes"), null, (id) => all.get(id), fromVentes).map((f) => f.field)).toEqual(["region"]);
    expect(visualFilters(target, v("magasins"), null, (id) => all.get(id), fromVentes).map((f) => f.field)).toEqual(["region"]);
    expect(visualFilters(target, v("autre"), null, (id) => all.get(id), fromVentes)).toEqual([]);
  });
});

describe("présentation", () => {
  it("déroule les pages ordinaires, en boucle, et cadre la page entière", () => {
    expect(presentationPages(report).map((p) => p.id)).toEqual(["synthese"]);
    expect(step(0, 3, 1)).toBe(1);
    expect(step(2, 3, 1)).toBe(0);
    expect(step(0, 3, -1)).toBe(2);
    expect(step(0, 0, 1)).toBe(0);
    expect(fitScale({ width: 1280, height: 720 }, { width: 1920, height: 1080 })).toBe(1.5);
    expect(fitScale({ width: 1280, height: 720 }, { width: 1280, height: 1080 }, 0)).toBe(1);
    expect(fitScale({ width: 1280, height: 720 }, { width: 0, height: 0 })).toBe(1);
  });
});

describe("store : extraction", () => {
  beforeEach(() => useStudio.getState().load(structuredClone(report)));

  it("ouvre la page filtrée puis revient à la page d'origine", () => {
    const s = useStudio.getState;
    expect(s().pageId).toBe("synthese");
    s().drillThrough("region", "ventes", [{ field: "region", op: "in", values: ["Nord"] }]);
    expect(s().pageId).toBe("region");
    expect(s().extraction).toMatchObject({ fromPageId: "synthese", datasetId: "ventes" });
    s().backFromExtraction();
    expect(s().pageId).toBe("synthese");
    expect(s().extraction).toBeNull();
    // Changer de page à la main abandonne l'extraction.
    s().drillThrough("region", "ventes", []);
    s().setPage("produit");
    expect(s().extraction).toBeNull();
  });

  it("définit les champs d'extraction de la page courante", () => {
    const s = useStudio.getState;
    s().setDrillthrough(["region", "produit"]);
    expect(s().report?.pages[0]?.drillthrough).toEqual({ fields: ["region", "produit"] });
    s().setDrillthrough(null);
    expect(s().report?.pages[0]?.drillthrough).toBeNull();
  });
});
