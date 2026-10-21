import { describe, expect, it } from "vitest";

import type { DatasetProfile } from "../types/dataset";
import type { Visual } from "../types/report";
import { numberFormat } from "./common";
import { bindingKey, bindingLabel, dateFields, measure, withShow } from "./fields";
import { formatNumber } from "./format";

const col = (name: string, type: "number" | "string" | "date") => ({ name, type, nulls: 0, distinct: 1, min: null, max: null, mean: null, top_values: [] });
const profile: DatasetProfile = {
  id: "d",
  name: "ventes",
  format: "csv",
  rows: 1,
  columns_count: 4,
  created_at: "",
  columns: [col("ca", "number"), col("region", "string"), col("commande", "date"), col("livraison", "date")],
  sample: [],
};
const visual = (roles: Visual["roles"], options: Visual["options"] = {}): Visual => ({ id: "v", type: "column", title: null, layout: { x: 0, y: 0, w: 1, h: 1 }, roles, options, filters: [] });

describe("calculs rapides (Afficher la valeur comme)", () => {
  it("clé, libellé et mesure envoyée identiques au backend", () => {
    const b = { field: "ca", agg: "sum" as const, show: { kind: "moving_avg" as const, date: "commande", window: 6 } };
    expect(bindingKey(b)).toBe("sum(ca)@moving_avg6");
    expect(bindingKey({ ...b, show: { kind: "ytd", date: "commande" } })).toBe("sum(ca)@ytd");
    expect(bindingLabel(b)).toBe("Moyenne mobile (6 périodes) — Somme de ca");
    expect(bindingLabel({ field: "Marge", agg: "calc", show: { kind: "yoy_pct", date: "commande" } })).toBe("Évolution vs N-1 — Marge");
    expect(measure(b)).toEqual({ field: "ca", agg: "sum", show: { kind: "moving_avg", date: "commande", window: 6 } });
    expect(measure({ field: "ca", agg: "sum" })).toEqual({ field: "ca", agg: "sum" });
  });

  it("prend la date de l'axe du visuel, sinon la première du jeu", () => {
    const onAxis = visual({ category: [{ field: "livraison", bin: "month" }], values: [{ field: "ca", agg: "sum" }] });
    expect(dateFields(onAxis, profile)).toEqual(["livraison", "commande"]);
    const v = withShow({ field: "ca", agg: "sum" }, "ytd", onAxis, profile);
    expect(v?.show).toEqual({ kind: "ytd", date: "livraison" });
    const kpi = visual({ values: [{ field: "ca", agg: "sum" }] });
    expect(withShow({ field: "ca", agg: "sum" }, "prev_year", kpi, profile)?.show?.date).toBe("commande");
    expect(withShow({ field: "ca", agg: "sum" }, "moving_avg", kpi, profile)?.show).toEqual({ kind: "moving_avg", date: "commande", window: 3 });
    // Sans champ date : seul « % du total » est possible.
    const noDate = { ...profile, columns: profile.columns.filter((c) => c.type !== "date") };
    expect(withShow({ field: "ca", agg: "sum" }, "ytd", kpi, noDate)).toBeNull();
    expect(withShow({ field: "ca", agg: "sum" }, "pct_total", kpi, noDate)?.show).toEqual({ kind: "pct_total" });
    expect(withShow({ field: "ca", agg: "sum", show: { kind: "ytd", date: "commande" } }, null, kpi, profile)).toEqual({ field: "ca", agg: "sum" });
  });

  it("formate les pourcentages, valeur par valeur", () => {
    const pct = { field: "ca", agg: "sum" as const, show: { kind: "yoy_pct" as const, date: "commande" } };
    const plain = { field: "ca", agg: "sum" as const };
    const mixed = visual({ values: [plain, pct] }, { compact: true, suffix: " €" });
    expect(formatNumber(12.345, numberFormat(mixed, pct))).toBe("12,3 %");
    expect(numberFormat(mixed, plain)).toMatchObject({ compact: true, suffix: " €" });
    expect(numberFormat(mixed).suffix).toBe(" €"); // format d'axe : pas tout en %
    expect(formatNumber(-4.06, numberFormat(visual({ values: [pct] })))).toBe("-4,1 %");
  });
});
