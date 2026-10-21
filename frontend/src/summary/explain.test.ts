import { describe, expect, it } from "vitest";

import type { ColumnProfile, DatasetProfile } from "../types/dataset";
import type { Visual } from "../types/report";
import type { QueryResult } from "../visuals/useQueryResult";
import { previewVisual, suggestions } from "./ask";
import { bestDimensions, breakdown, candidateDimensions, dimensionRequests, explainFacts, explainTarget } from "./explain";

const col = (name: string, type: ColumnProfile["type"], distinct: number): ColumnProfile => ({ name, type, nulls: 0, distinct, min: null, max: null, mean: null, top_values: [] });
const profile = {
  id: "d",
  name: "ventes",
  columns: [col("date", "date", 300), col("region", "string", 5), col("produit", "string", 4), col("client", "string", 400), col("ca", "number", 500), col("code_id", "number", 30)],
} as DatasetProfile;
const line: Visual = {
  id: "l",
  type: "line",
  title: "CA mensuel",
  layout: { x: 0, y: 0, w: 1, h: 1 },
  dataset_id: "d",
  roles: { category: [{ field: "date", bin: "month" }], values: [{ field: "ca", agg: "sum" }] },
  options: {},
  filters: [],
};
const res = (rows: Record<string, unknown>[], dim = "date|month", key = "sum(ca)"): QueryResult =>
  ({ columns: [{ key: dim, field: dim.split("|")[0], role: "dimension", type: "string" }, { key, field: "ca", role: "measure", type: "number" }], rows, truncated: false }) as QueryResult;
const monthly = res([
  { "date|month": "2026-01-01", "sum(ca)": 100 },
  { "date|month": "2026-02-01", "sum(ca)": 120 },
  { "date|month": "2026-03-01", "sum(ca)": 90 },
]);
const sel = (field: string, value: string, bin: "month" | null = "month") => ({ visualId: "l", datasetId: "d", keys: [value], filters: [{ field, op: "in" as const, values: [value], bin }] });

describe("expliquer une valeur", () => {
  it("compare à la période précédente sur un axe de dates, sinon à l'ensemble", () => {
    const t = explainTarget(line, monthly, sel("date", "2026-03-01"), profile);
    expect(t).toMatchObject({ mode: "previous", current: "2026-03-01", previous: "2026-02-01", currentValue: 90, previousValue: 120 });
    expect(explainTarget(line, monthly, sel("date", "2026-01-01"), profile)).toMatchObject({ mode: "share", previous: null });
    const bar = { ...line, roles: { category: [{ field: "region" }], values: [{ field: "ca", agg: "sum" as const }] } };
    expect(explainTarget(bar, res([{ region: "Nord", "sum(ca)": 5 }], "region"), sel("region", "Nord", null), profile)).toMatchObject({ mode: "share" });
    expect(explainTarget({ ...line, roles: { ...line.roles, values: [{ field: "ca", agg: "avg" }] } }, monthly, sel("date", "2026-03-01"), profile)).toMatch(/additif/);
    expect(explainTarget(line, monthly, null, profile)).toMatch(/Cliquez droit/);
  });

  it("choisit les dimensions et construit les requêtes", () => {
    expect(candidateDimensions(profile, "date").map((c) => c.name)).toEqual(["produit", "region"]);
    const related = { ...profile, columns: [...profile.columns, { ...col("regions.zone", "string", 3), related: "regions" }], model: { columns: [], measures: [], relations: [{ name: "regions", dataset_id: "r", from_column: "region", to_column: "region" }] } };
    expect(candidateDimensions(related, "region").map((c) => c.name)).toEqual(["produit"]);
    expect(candidateDimensions(related, "date").map((c) => c.name)).toEqual(["regions.zone", "produit", "region"]);
    const t = explainTarget(line, monthly, sel("date", "2026-03-01"), profile);
    if (typeof t === "string") throw new Error(t);
    const reqs = dimensionRequests("d", t, "region", [
      { field: "date", op: "in", values: ["2026-03-01"], bin: "month" },
      { field: "produit", op: "in", values: ["A"] },
    ]);
    expect(reqs.current.filters).toEqual([{ field: "produit", op: "in", values: ["A"] }, { field: "date", op: "in", values: ["2026-03-01"], bin: "month" }]);
    expect(reqs.base.filters?.at(-1)).toEqual({ field: "date", op: "in", values: ["2026-02-01"], bin: "month" });
    expect(reqs.current.dimensions).toEqual([{ field: "region" }]);
  });

  it("décompose l'écart et l'écrit en constats vérifiables", () => {
    const t = explainTarget(line, monthly, sel("date", "2026-03-01"), profile);
    if (typeof t === "string") throw new Error(t);
    const cur = res([{ region: "Nord", "sum(ca)": 30 }, { region: "Sud", "sum(ca)": 50 }, { region: "Est", "sum(ca)": 10 }], "region");
    const prev = res([{ region: "Nord", "sum(ca)": 70 }, { region: "Sud", "sum(ca)": 45 }, { region: "Ouest", "sum(ca)": 5 }], "region");
    const b = breakdown(t, "region", cur, prev);
    expect(b.items.map((i) => [i.key, i.delta])).toEqual([["Nord", -40], ["Est", 10], ["Sud", 5], ["Ouest", -5]]);
    expect(b.totals).toEqual({ current: 90, base: 120 });
    expect(b.score).toBeCloseTo(40 / 60);
    const flat = b.items.map((i) => ({ ...i, delta: 1 }));
    expect(bestDimensions([{ ...b, dimension: "x", score: 0.1, items: flat }, b]).map((d) => d.dimension)).toEqual(["region", "x"]);
    const facts = explainFacts(line, t, [b], "date").map((f) => f.replace(/\s/g, " "));
    expect(facts[0]).toBe("Somme de ca : mars 2026 — 90 ; févr. 2026 — 120");
    expect(facts[1]).toBe("Écart de févr. 2026 à mars 2026 : -30 (-25 %)");
    expect(facts[2]).toBe("region = Nord : -40 (-133 % de l'écart), de 70 à 30");
    // Mode « part » : répartition de l'élément contre celle de l'ensemble.
    const share = { ...t, mode: "share" as const, previous: null, previousValue: null };
    const s = breakdown(share, "region", cur, prev);
    expect(explainFacts(line, share, [s], "date")[1]?.replace(/\s/g, " ")).toMatch(/^region = Nord : 33 % de mars 2026 contre 58 % de l'ensemble \(-25 points\)$/);
  });

  it("propose des questions et prépare l'aperçu d'une réponse", () => {
    expect(suggestions(profile)).toEqual(["Quel region a le plus de ca ?", "Comment évolue ca par mois ?", "Quel est le total de ca ?", "Combien de lignes par region ?"]);
    expect(suggestions(undefined)).toEqual([]);
    const v = previewVisual({ type: "kpi", title: "CA", roles: { values: [{ field: "ca", agg: "sum" }] }, options: {} }, "d", "ask-1");
    expect(v).toMatchObject({ id: "ask-1", dataset_id: "d", type: "kpi", filters: [] });
  });
});
