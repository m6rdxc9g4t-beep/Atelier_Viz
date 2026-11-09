import { describe, expect, it } from "vitest";

import { bandKey, forecastKey, linearFit, nextPeriods, predict, seasonOf, seasonPeriod, seasonalModel, student975, trendApplies, trendKey, withTrend } from "./trend";
import type { Datum, SeriesDef } from "./series";

const s: SeriesDef = { key: "sum(ca)", label: "CA", color: "var(--series-1)", role: "values" };
const months = (values: (number | null)[]): Datum[] =>
  values.map((v, i) => ({ __cat: `2026-${String(i + 1).padStart(2, "0")}-01`, __label: `m${i + 1}`, "sum(ca)": v }));

describe("tendance linéaire", () => {
  it("retrouve une droite exacte (R² = 1, intervalle nul)", () => {
    const fit = linearFit([1, 3, 5, 7]);
    expect(fit).not.toBeNull();
    if (!fit) return;
    expect(fit.slope).toBeCloseTo(2);
    expect(fit.intercept).toBeCloseTo(1);
    expect(fit.r2).toBeCloseTo(1);
    expect(predict(fit, 4)).toEqual({ value: 9, margin: 0 });
  });

  it("ignore les vides et refuse moins de 3 points", () => {
    expect(linearFit([1, null, 2])).toBeNull();
    expect(linearFit([5, 5, 5])?.slope).toBe(0);
    expect(linearFit([2, null, 6, 8])?.slope).toBeCloseTo(2);
  });

  it("élargit l'intervalle de prévision en s'éloignant", () => {
    const fit = linearFit([10, 14, 11, 16, 15, 19]);
    if (!fit) throw new Error("ajustement attendu");
    const near = predict(fit, 6).margin;
    const far = predict(fit, 12).margin;
    expect(near).toBeGreaterThan(0);
    expect(far).toBeGreaterThan(near);
    expect(student975(4)).toBeCloseTo(2.776);
    expect(student975(200)).toBe(1.96);
  });

  it("enchaîne les périodes d'un axe de dates regroupé", () => {
    expect(nextPeriods("2026-11-01", "month", 3)).toEqual(["2026-12-01", "2027-01-01", "2027-02-01"]);
    expect(nextPeriods("2026-10-01", "quarter", 2)).toEqual(["2027-01-01", "2027-04-01"]);
    expect(nextPeriods("2026-01-01", "year", 1)).toEqual(["2027-01-01"]);
    expect(nextPeriods("Occitanie", "month", 3)).toEqual([]);
    expect(nextPeriods("2026-01-01", null, 3)).toEqual([]);
  });
});

describe("withTrend", () => {
  it("ajoute la tendance sans toucher aux données d'origine", () => {
    const data = months([1, 3, 5, 7]);
    const out = withTrend(data, [s], { trend: true, forecast: 0, catType: "date", bin: "month" });
    expect(out.data).toHaveLength(4);
    expect(out.data[3]?.[trendKey(s.key)]).toBeCloseTo(7);
    expect(data[0]).not.toHaveProperty(trendKey(s.key));
    expect(out.derived.map((d) => d.kind)).toEqual(["trend"]);
    expect(out.forecastStart).toBeNull();
  });

  it("prolonge un axe de dates, raccordé au dernier point réel", () => {
    const out = withTrend(months([1, 3, 5, 7]), [s], { trend: false, forecast: 2, catType: "date", bin: "month" });
    expect(out.data).toHaveLength(6);
    expect(out.data[3]?.[forecastKey(s.key)]).toBe(7);
    expect(out.data[4]).toMatchObject({ __cat: "2026-05-01", __label: "mai 2026", __forecast: true });
    expect(out.data[4]?.[forecastKey(s.key)]).toBeCloseTo(9);
    expect(out.data[5]?.[bandKey(s.key)]).toEqual([expect.closeTo(11), expect.closeTo(11)]);
    // Aucune valeur réelle inventée sur les périodes prévues.
    expect(out.data[4]?.[s.key]).toBeUndefined();
    expect(out.forecastStart).toBe("mai 2026");
  });

  it("ne prévoit pas sur un axe de catégories ni avec trop peu de points", () => {
    const regions: Datum[] = ["A", "B", "C", "D"].map((r, i) => ({ __cat: r, __label: r, "sum(ca)": i }));
    expect(withTrend(regions, [s], { trend: false, forecast: 3, catType: "string", bin: null }).data).toHaveLength(4);
    expect(withTrend(months([1, 2, 3]), [s], { trend: false, forecast: 3, catType: "date", bin: "month" }).derived).toEqual([]);
  });

  it("ne s'applique qu'à un axe trié par catégorie, ni empilé ni à 100 %", () => {
    expect(trendApplies({})).toBe(true);
    expect(trendApplies({ sort: "category" })).toBe(true);
    expect(trendApplies({ sort: "value_desc" })).toBe(false);
    expect(trendApplies({ stacked: true })).toBe(false);
    expect(trendApplies({ percent: true })).toBe(false);
  });
});

describe("prévision saisonnière", () => {
  // 3 ans de mois : tendance +10 / mois et un pic de +100 en décembre.
  const monthly: Datum[] = Array.from({ length: 36 }, (_, i) => {
    const d = new Date(2024, i, 1);
    const cat = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
    return { __cat: cat, __label: cat, "sum(ca)": 1000 + 10 * i + (d.getMonth() === 11 ? 100 : 0) };
  });

  it("repère le cycle et la position de chaque date", () => {
    expect([seasonPeriod("month"), seasonPeriod("quarter"), seasonPeriod("day"), seasonPeriod("year")]).toEqual([12, 4, 7, null]);
    expect(seasonOf("2026-12-01", "month")).toBe(11);
    expect(seasonOf("2026-08-01", "quarter")).toBe(2);
    expect(seasonOf("Occitanie", "month")).toBeNull();
  });

  it("reproduit le pic de décembre dans la prévision", () => {
    const out = withTrend(monthly, [s], { trend: false, forecast: 12, catType: "date", bin: "month", seasonal: true });
    const dec = out.data.find((d) => d.__cat === "2027-12-01");
    const nov = out.data.find((d) => d.__cat === "2027-11-01");
    expect(dec?.__forecast).toBe(true);
    // À 1 % près (la droite est un peu tirée par les pics) ; le saut novembre → décembre est retrouvé.
    expect(Math.abs(Number(dec?.[forecastKey(s.key)]) / 1570 - 1)).toBeLessThan(0.01);
    expect(Number(dec?.[forecastKey(s.key)]) - Number(nov?.[forecastKey(s.key)])).toBeGreaterThan(100);
    expect(out.derived.find((d) => d.kind === "forecast")?.seasonal).toBe(true);
  });

  it("revient à la droite sans deux cycles complets", () => {
    const out = withTrend(monthly.slice(0, 18), [s], { trend: false, forecast: 3, catType: "date", bin: "month", seasonal: true });
    expect(out.derived.find((d) => d.kind === "forecast")?.seasonal).toBe(false);
  });

  it("ne calcule rien si un mois manque d'observations", () => {
    const fit = linearFit([1, 2, 3, 4]);
    if (!fit) throw new Error("ajustement attendu");
    expect(seasonalModel([1, 2, 3, 4], [0, 1, 2, 3], 4, fit)).toBeNull();
  });
});
