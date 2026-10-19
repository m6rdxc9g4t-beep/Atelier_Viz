import { fieldRef, updateModel } from "../studio/ModelEditor";
import { bestRole, bindInto, useStudio } from "../studio/store";
import type { ColumnProfile, DatasetProfile } from "../types/dataset";
import type { Report, Visual } from "../types/report";
import { genericQuery } from "./common";
import { canDrill, dateHierarchy, drillCrumbs, drillDown, drillState, drillUp, drillView, nextLevel } from "./drill";
import { bindingKey, bindingLabel, defaultBinding, findField, measureField } from "./fields";
import { VISUALS } from "./registry";

const col = (name: string, type: ColumnProfile["type"]): ColumnProfile => ({ name, type, nulls: 0, distinct: 5, min: null, max: null, mean: null, top_values: [] });

const dataset: DatasetProfile = {
  id: "abcdefabcdef",
  name: "ventes.csv",
  format: "csv",
  rows: 10,
  columns_count: 4,
  created_at: "2026-01-01T00:00:00Z",
  columns: [col("region", "string"), col("ville", "string"), col("ca", "number"), col("date", "date"), { ...col("ttc", "number"), calculated: true, expression: "ca * 1.2" }],
  sample: [],
  model: { columns: [{ name: "ttc", expression: "ca * 1.2" }], measures: [{ name: "marge", expression: "SUM(ca) - SUM(cout)" }] },
};

const visual = (type: Visual["type"], roles: Visual["roles"] = {}, options: Visual["options"] = {}): Visual => ({
  id: "v1",
  type,
  title: null,
  layout: { x: 0, y: 0, w: 8, h: 8 },
  dataset_id: dataset.id,
  roles,
  options,
  filters: [],
});

describe("mesures et colonnes calculées", () => {
  it("présente une mesure comme un champ glissable, liée en agg « calc »", () => {
    const m = findField(dataset, "marge", true) as ColumnProfile;
    expect(m).toMatchObject({ name: "marge", measure: true, type: "number" });
    expect(defaultBinding(m, false)).toEqual({ field: "marge", agg: "calc" });
    expect(bindingKey({ field: "marge", agg: "calc" })).toBe("calc(marge)");
    expect(bindingLabel({ field: "marge", agg: "calc" })).toBe("marge");
    expect(findField(dataset, "ttc")?.calculated).toBe(true);
    expect(findField(dataset, "inconnue", true)).toBeUndefined();
  });

  it("place une mesure dans les valeurs, jamais dans un axe", () => {
    const v = visual("column");
    const m = measureField(dataset.model!.measures[0]!);
    expect(bestRole(v, m)?.id).toBe("values");
    expect(bindInto(v, VISUALS.column.roles[0]!, m, dataset.id)).toMatch(/mesure calculée/);
    expect(bindInto(v, VISUALS.column.roles[2]!, m, dataset.id)).toBeNull();
    expect(genericQuery({ ...v, roles: { ...v.roles, category: [{ field: "region" }] } }, VISUALS.column, [])?.measures).toEqual([{ field: "marge", agg: "calc" }]);
  });

  it("met à jour le modèle : ajout, modification, suppression", () => {
    const model = dataset.model!;
    expect(updateModel(model, "measure", null, { name: "taux", expression: "x" }).measures.map((m) => m.name)).toEqual(["marge", "taux"]);
    expect(updateModel(model, "measure", "marge", { name: "marge brute", expression: "y" }).measures).toEqual([{ name: "marge brute", expression: "y" }]);
    expect(updateModel(model, "column", "ttc", null).columns).toEqual([]);
  });

  it("écrit les noms à insérer entre crochets si besoin", () => {
    expect(fieldRef("chiffre_affaires")).toBe("chiffre_affaires");
    expect(fieldRef("région")).toBe("région");
    expect(fieldRef("chiffre d'affaires")).toBe("[chiffre d'affaires]");
    expect(fieldRef("2026")).toBe("[2026]");
  });

  it("répercute un renommage dans les visuels et filtres du rapport", () => {
    const v = visual("column", { category: [{ field: "ttc" }], values: [{ field: "marge", agg: "calc" }, { field: "marge", agg: "sum" }] });
    v.filters = [{ field: "ttc", op: "gt", values: [1] }];
    const report: Report = { id: "r", name: "R", version: 1, created_at: "", updated_at: "", theme: {}, dataset_id: null, pages: [{ id: "p", name: "P", visuals: [v], filters: [] }] };
    useStudio.getState().load(report);
    useStudio.getState().renameField(dataset.id, "marge", "marge brute", true);
    useStudio.getState().renameField(dataset.id, "ttc", "prix ttc", false);
    const after = useStudio.getState().report!.pages[0]!.visuals[0]!;
    expect(after.roles.values).toEqual([{ field: "marge brute", agg: "calc" }, { field: "marge", agg: "sum" }]);
    expect(after.roles.category).toEqual([{ field: "prix ttc" }]);
    expect(after.filters[0]?.field).toBe("prix ttc");
  });
});

describe("exploration (drill-down)", () => {
  const roles = { category: [{ field: "region" }, { field: "ville" }], values: [{ field: "ca", agg: "sum" as const }] };

  it("n'explore que les visuels à Axe avec au moins deux niveaux", () => {
    expect(canDrill(visual("column", roles))).toBe(true);
    expect(canDrill(visual("column", { ...roles, category: [{ field: "region" }] }))).toBe(false);
    expect(canDrill(visual("table", { columns: roles.category }))).toBe(false);
    const flat = visual("column", { category: [{ field: "region" }] });
    expect(drillView(flat)).toBe(flat);
  });

  it("affiche le niveau courant et filtre sur le chemin exploré", () => {
    const v = visual("column", roles);
    const top = drillView(v);
    expect(top.roles.category).toEqual([{ field: "region" }]);
    expect(genericQuery(top, VISUALS.column, [])?.dimensions).toEqual([{ field: "region", bin: null }]);

    const down = drillDown(v, "Occitanie")!;
    expect(down).toEqual({ level: 1, path: [{ value: "Occitanie" }] });
    const view = drillView({ ...v, options: { drill: down } });
    expect(view.roles.category).toEqual([{ field: "ville" }]);
    expect(view.filters).toEqual([{ field: "region", op: "in", values: ["Occitanie"], bin: null }]);
    expect(drillCrumbs({ ...v, options: { drill: down } }, dataset)).toEqual(["Occitanie", "ville"]);
    expect(drillDown({ ...v, options: { drill: down } }, "Toulouse")).toBeNull(); // dernier niveau
    expect(drillUp({ ...v, options: { drill: down } })).toEqual({ level: 0, path: [] });
  });

  it("niveau suivant : tous les membres, sans filtre", () => {
    const v = visual("bar", roles);
    const next = nextLevel(v)!;
    const view = drillView({ ...v, options: { drill: next } });
    expect(view.roles.category).toEqual([{ field: "ville" }]);
    expect(view.filters).toEqual([]);
    expect(drillCrumbs({ ...v, options: { drill: next } }, dataset)).toEqual(["region (tout)", "ville"]);
  });

  it("borne un état enregistré devenu incohérent (niveau retiré)", () => {
    const v = visual("column", roles, { drill: { level: 5, path: [{ value: "A" }, { value: "B" }, null] } });
    expect(drillState(v)).toEqual({ level: 1, path: [{ value: "A" }] });
  });

  it("hiérarchie de dates : année › trimestre › mois, filtres par période", () => {
    const h = dateHierarchy({ field: "date", bin: "month" });
    expect(h).toEqual([{ field: "date", bin: "year" }, { field: "date", bin: "quarter" }, { field: "date", bin: "month" }]);
    const v = visual("line", { category: h, values: roles.values });
    const view = drillView({ ...v, options: { drill: drillDown(v, "2026-01-01") } });
    expect(view.roles.category).toEqual([{ field: "date", bin: "quarter" }]);
    expect(view.filters).toEqual([{ field: "date", op: "in", values: ["2026-01-01"], bin: "year" }]);
    expect(drillCrumbs({ ...v, options: { drill: drillDown(v, "2026-01-01") } }, dataset)).toEqual(["2026", "date (Trimestre)"]);
  });
});
