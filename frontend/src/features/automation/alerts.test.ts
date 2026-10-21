import { describe, expect, it } from "vitest";

import type { Alert } from "../../types/alert";
import type { DatasetProfile } from "../../types/dataset";
import type { Visual } from "../../types/report";
import { alertError, alertFromVisual, alertStatus, alertValueLabel, conditionLabel, emptyAlert, filterLabel, measureLabel, parseFilterValues } from "./alerts";

const kpi: Visual = {
  id: "k",
  type: "kpi",
  title: "CA total",
  layout: { x: 0, y: 0, w: 200, h: 100 },
  dataset_id: "d1",
  roles: { values: [{ field: "ca", agg: "sum" }], target: [{ field: "objectif", agg: "sum" }] },
  options: {},
  filters: [],
};

const profile = {
  id: "d1",
  columns: [
    { name: "ca", type: "number" },
    { name: "region", type: "string" },
  ],
  model: { columns: [], measures: [{ name: "Marge", expression: "SUM(ca)" }] },
} as unknown as DatasetProfile;

describe("alertes", () => {
  it("décrit la mesure, la condition et les filtres", () => {
    expect(measureLabel({ field: "ca", agg: "sum" })).toBe("Somme de ca");
    expect(measureLabel({ field: "Marge", agg: "calc" })).toBe("Marge");
    expect(measureLabel({ field: null, agg: "count" })).toBe("Nombre de lignes");
    expect(conditionLabel({ measure: { field: "ca", agg: "sum" }, comparison: "gte", threshold: 150000 })).toBe("Somme de ca ≥ 150 000");
    expect(filterLabel({ field: "region", op: "in", values: ["Nord", "Sud"] })).toBe("region ∈ Nord, Sud");
    expect(filterLabel({ field: "ca", op: "between", values: [1, 5] })).toBe("ca entre 1 et 5");
  });

  it("pré-remplit une alerte depuis un KPI (mesure, filtres, cible) et refuse les autres visuels", () => {
    const filters = [{ field: "region", op: "in" as const, values: ["Nord"] }];
    const draft = alertFromVisual(kpi, filters, { value: 1234.567, target: 2000 });
    expect(draft).toMatchObject({ name: "CA total", dataset_id: "d1", measure: { field: "ca", agg: "sum" }, comparison: "lt", threshold: 2000 });
    expect(draft?.filters).toEqual(filters);
    expect(draft?.filters).not.toBe(filters);
    expect(alertFromVisual({ ...kpi, roles: { values: [{ field: "ca", agg: "sum" }] } }, [], { value: 1234.567, target: null })).toMatchObject({ comparison: "gt", threshold: 1234.57 });
    expect(alertFromVisual({ ...kpi, type: "column" }, [], { value: 1, target: null })).toBeNull();
    expect(alertFromVisual({ ...kpi, dataset_id: null }, [], { value: 1, target: null })).toBeNull();
  });

  it("contrôle la saisie", () => {
    const ok = { ...emptyAlert("d1"), name: "A", measure: { field: "ca", agg: "sum" as const } };
    expect(alertError(ok, profile)).toBeNull();
    expect(alertError({ ...ok, name: " " }, profile)).toMatch(/nom/);
    expect(alertError({ ...ok, threshold: Number.NaN }, profile)).toMatch(/nombre/);
    expect(alertError({ ...ok, notify: false, system: false }, profile)).toMatch(/au moins une action/);
    expect(alertError({ ...ok, webhook: { url: "ftp://x", method: "POST" } }, profile)).toMatch(/webhook/);
    expect(alertError({ ...ok, measure: { field: "Marge", agg: "calc" } }, profile)).toBeNull();
    expect(alertError({ ...ok, measure: { field: "inconnu", agg: "sum" } }, profile)).toMatch(/inconnu/);
  });

  it("type les valeurs d'un filtre saisi", () => {
    expect(parseFilterValues("Nord; Sud ;", { type: "string" } as never, "in")).toEqual(["Nord", "Sud"]);
    expect(parseFilterValues("1 234,5", { type: "number" } as never, "gt")).toEqual([1234.5]);
    expect(parseFilterValues("oui", { type: "boolean" } as never, "eq")).toEqual([true]);
  });

  it("calcule l'état affiché", () => {
    const base = { enabled: true, met: null, history: [] } as unknown as Alert;
    expect(alertStatus(base)).toBe("never");
    expect(alertStatus({ ...base, met: true })).toBe("fired");
    expect(alertStatus({ ...base, met: false })).toBe("ok");
    expect(alertStatus({ ...base, enabled: false, met: true })).toBe("off");
    expect(alertStatus({ ...base, history: [{ error: "Mesure invalide" }] } as unknown as Alert)).toBe("error");
  });
});

describe("alertes sur variation et par dimension", () => {
  const base = { ...emptyAlert("a".repeat(12)), name: "CA", measure: { field: "ca", agg: "sum" as const }, threshold: -10, comparison: "lte" as const };

  it("décrit la condition", () => {
    expect(conditionLabel({ ...base, basis: "change_pct" })).toBe("Variation de Somme de ca ≤ -10 %");
    expect(conditionLabel({ ...base, basis: "change_abs", threshold: 500, comparison: "gt" })).toBe("Écart de Somme de ca > 500");
    expect(conditionLabel({ ...base, basis: "value", split_by: "region", threshold: 100, comparison: "gt" })).toBe("Somme de ca > 100 · pour chaque region");
  });

  it("affiche la dernière valeur ou le nombre de valeurs au-delà du seuil", () => {
    const alert = { ...base, id: "x", created_at: "", met: true, last_value: 12.5, last_evaluated_at: null, last_fired_at: null, history: [] };
    expect(alertValueLabel({ ...alert, basis: "change_pct" })).toBe("+12,5 %");
    expect(alertValueLabel({ ...alert, basis: "value", last_value: null })).toBe("—");
    const groups = { Nord: { met: true, value: 130, raw: 130 }, Sud: { met: false, value: 50, raw: 50 }, Est: { met: false, value: 80, raw: 80 } };
    expect(alertValueLabel({ ...alert, split_by: "region", groups })).toBe("1 / 3");
    expect(alertValueLabel({ ...alert, split_by: "region", groups: {} })).toBe("—");
  });

  it("accepte la notification système seule, refuse une dimension inconnue", () => {
    expect(alertError({ ...base, notify: false, system: true }, undefined)).toBeNull();
    expect(alertError({ ...base, notify: false, system: false }, undefined)).toMatch(/au moins une action/);
    const profile = { columns: [{ name: "ca" }, { name: "region" }] } as unknown as DatasetProfile;
    expect(alertError({ ...base, split_by: "pays" }, profile)).toMatch(/inconnu/);
    expect(alertError({ ...base, split_by: "region" }, profile)).toBeNull();
  });
});
