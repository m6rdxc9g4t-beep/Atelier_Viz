import { describe, expect, it } from "vitest";

import { applyBookmarkTo, captureBookmark } from "../../studio/bookmarks";
import type { DatasetProfile } from "../../types/dataset";
import type { Report, Visual } from "../../types/report";
import { clampToStep, pageParameters, parameterSpec, usedParameterNames, withParameters } from "./parameters";

const param = (id: string, options: Visual["options"] = {}): Visual => ({
  id,
  type: "parameter",
  title: null,
  layout: { x: 0, y: 0, w: 300, h: 100 },
  dataset_id: null,
  roles: {},
  options,
  filters: [],
});

const profile = (measures: string[]): DatasetProfile =>
  ({
    id: "d1",
    name: "ventes.csv",
    format: "csv",
    rows: 1,
    columns_count: 1,
    created_at: "2026-01-01T00:00:00Z",
    columns: [],
    sample: [],
    model: { columns: [], measures: measures.map((expression, i) => ({ name: `m${i}`, expression })) },
  }) as DatasetProfile;

describe("paramètres de simulation", () => {
  it("lit la définition avec des valeurs par défaut et borne la valeur", () => {
    expect(parameterSpec(param("p"))).toEqual({ name: "croissance", min: 0, max: 20, step: 1, default: 5, value: 5 });
    expect(parameterSpec(param("p", { name: "remise", min: 10, max: -10, step: 0.5, value: 3.3 }))).toMatchObject({ min: -10, max: 10, value: 3.5 });
    expect(parameterSpec(param("p", { value: 999 }))?.value).toBe(20);
    expect(parameterSpec(param("p", { name: 'x"); DROP' }))).toBeNull();
    expect(parameterSpec({ ...param("p"), type: "slicer" })).toBeNull();
    expect(clampToStep(0.30000000000000004, 0, 1, 0.1)).toBe(0.3);
  });

  it("donne les valeurs des curseurs de la page, le premier l'emportant à nom égal", () => {
    const page = { visuals: [param("a", { name: "taux", value: 4 }), param("b", { name: "taux", value: 9 }), param("c", { name: "prix", default: 2 })] };
    expect(pageParameters(page)).toEqual({ taux: 4, prix: 2 });
    expect(pageParameters({ visuals: [] })).toEqual({});
  });

  it("n'envoie que les paramètres cités par les mesures du jeu", () => {
    const p = profile(['SUM(ca) * (1 + PARAM("taux", 5) / 100)', "paramètre('prix', 1) + 0"]);
    expect([...usedParameterNames(p)].sort()).toEqual(["prix", "taux"]);
    const req = { dataset_id: "d1", measures: [{ field: "m0", agg: "calc" as const }] };
    expect(withParameters(req, { taux: 3, autre: 1 }, p)).toEqual({ ...req, parameters: { taux: 3 } });
    // Aucun paramètre utilisé : requête inchangée (même clé de cache, pas de rechargement).
    expect(withParameters(req, { autre: 1 }, p)).toBe(req);
    expect(withParameters(null, { taux: 3 }, p)).toBeNull();
    expect(withParameters(req, { taux: 3 })).toEqual({ ...req, parameters: { taux: 3 } });
  });

  it("est retenu par un signet et rétabli", () => {
    const report: Report = {
      id: "r",
      version: 1,
      name: "R",
      theme: {},
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      pages: [{ id: "p1", name: "P", filters: [], visuals: [param("k", { name: "taux", value: 7 })] }],
    };
    const b = captureBookmark(report, "p1", null, { id: "b", name: "Scénario haut" });
    expect(b.pages.p1?.visuals.k?.value).toBe(7);
    report.pages[0]!.visuals[0]!.options.value = 1;
    expect(applyBookmarkTo(report, b, "p1", null).missing).toBe(0);
    expect(report.pages[0]!.visuals[0]!.options.value).toBe(7);
  });
});
