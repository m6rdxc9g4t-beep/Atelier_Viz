import type { Page, Visual } from "../types/report";
import type { QueryResult } from "../visuals/useQueryResult";
import { pageAnalyses } from "./facts";
import { pageBrief } from "./pageSummary";
import { MAX_READING_POINTS, pageReading } from "./reading";

type Col = QueryResult["columns"][number];
const dim = (key: string, type: Col["type"] = "string"): Col => ({ key, field: key.split("|")[0] ?? key, role: "dimension", type });
const mea = (key: string): Col => ({ key, field: null, role: "measure", type: "number" });
const res = (columns: Col[], rows: QueryResult["rows"]): QueryResult => ({ columns, rows, truncated: false });
const plain = (text: string | undefined) => (text ?? "").replace(/[  ]/g, " ");

const eur = { compact: true, suffix: " €" };
const visual = (id: string, type: Visual["type"], title: string, roles: Visual["roles"], options: Visual["options"] = eur): Visual => ({
  id,
  type,
  title,
  layout: { x: 0, y: 0, w: 8, h: 8 },
  dataset_id: "ds",
  roles,
  options,
  filters: [],
});
const card = (id: string, title: string, field: string, agg: "sum" | "avg" | "max" | "count", options: Visual["options"] = eur) =>
  visual(id, "kpi", title, { values: [{ field, agg, label: title }] }, options);

/** Page « Trésorerie » de l'exemple Studio Garance, en réduction : cartes, mois, solde cumulé, postes. */
const cards = [card("rec", "Recettes", "Crédit", "sum"), card("dep", "Dépenses", "Débit", "sum"), card("sol", "Solde de la période", "Montant", "sum"), card("ops", "Opérations", "Montant", "count", { compact: true })];
const months = visual("mois", "column", "Recettes et dépenses par mois", { category: [{ field: "Mois" }], values: [{ field: "Crédit", agg: "sum", label: "Recettes" }, { field: "Débit", agg: "sum", label: "Dépenses" }] });
const running = visual("cumul", "area", "Solde cumulé", { category: [{ field: "Date", bin: "week" }], values: [{ field: "Montant", agg: "sum", label: "Solde cumulé", show: { kind: "running", date: "Date" } }] });
const posts = visual("postes", "bar", "Dépenses par catégorie", { category: [{ field: "Catégorie" }], values: [{ field: "Débit", agg: "sum", label: "Dépenses" }] });
const tresorerie: Page = { id: "p", name: "Trésorerie", visuals: [...cards, months, running, posts], filters: [] };

const results: Record<string, QueryResult> = {
  rec: res([mea("sum(Crédit)")], [{ "sum(Crédit)": 12950 }]),
  dep: res([mea("sum(Débit)")], [{ "sum(Débit)": 9098 }]),
  sol: res([mea("sum(Montant)")], [{ "sum(Montant)": 3852 }]),
  ops: res([mea("count(Montant)")], [{ "count(Montant)": 41 }]),
  mois: res([dim("Mois"), mea("sum(Crédit)"), mea("sum(Débit)")], [
    { Mois: "2026-08", "sum(Crédit)": 3600, "sum(Débit)": 2900 },
    { Mois: "2026-09", "sum(Crédit)": 4150, "sum(Débit)": 3398 },
    { Mois: "2026-10", "sum(Crédit)": 5200, "sum(Débit)": 2800 },
  ]),
  cumul: res([dim("Date|week", "date"), mea("sum(Montant)@running")], [
    { "Date|week": "2026-07-27", "sum(Montant)@running": -1200 },
    { "Date|week": "2026-09-07", "sum(Montant)@running": 1500 },
    { "Date|week": "2026-10-19", "sum(Montant)@running": 3900 },
    { "Date|week": "2026-10-26", "sum(Montant)@running": 3852 },
  ]),
  postes: res([dim("Catégorie"), mea("sum(Débit)")], [
    { Catégorie: "Locaux", "sum(Débit)": 3450 },
    { Catégorie: "Matériel", "sum(Débit)": 2100 },
    { Catégorie: "Charges sociales", "sum(Débit)": 1900 },
    { Catégorie: "Formation", "sum(Débit)": 450 },
    { Catégorie: "Banque", "sum(Débit)": 27 },
  ]),
};
const dataOf = (id: string) => (results[id] ? { result: results[id] as QueryResult, error: null, trend: null } : undefined);

describe("lecture calculée d'une page", () => {
  const reading = pageBrief(tresorerie, dataOf).reading;
  const texts = (reading?.points ?? []).map((p) => plain(p.text));

  it("ouvre par la page, sa période et ses chiffres clés, en une phrase", () => {
    expect(plain(reading?.headline)).toBe("Trésorerie, août 2026 → oct. 2026 : Recettes 13 k €, Dépenses 9,1 k €, Solde de la période 3,9 k €.");
    expect(reading?.period).toBe("août 2026 → oct. 2026");
  });

  it("rapporte les mesures de la page l'une à l'autre (dépenses rapportées aux recettes), reliées à leurs cartes", () => {
    expect(texts[0]).toBe("« Dépenses » (9,1 k €) représente 70 % de « Recettes » (13 k €) ; « Solde de la période » (3,9 k €) en représente 30 %.");
    expect(reading?.points[0]?.visuals).toEqual(["dep", "rec", "sol"]);
  });

  it("dit ce qui évolue, ce qui ressort, et relie chaque constat à son visuel", () => {
    expect(texts).toContain("« Recettes » est en hausse : de 3,6 k € (août 2026) à 5,2 k € (oct. 2026), soit +44 % ; « Dépenses » est en baisse : de 2,9 k € à 2,8 k €, soit -3,4 %.");
    expect(texts).toContain("« Solde cumulé » passe de -1,2 k € (sem. 27/07) à 3,9 k € (sem. 26/10) ; plus haut : 3,9 k € (sem. 19/10).");
    expect(texts).toContain("Locaux arrive en tête de « Dépenses par catégorie » avec 3,5 k €, soit 44 % du total ; les 3 premiers (Locaux, Matériel, Charges sociales) en font 94 %.");
    expect(reading?.points.find((p) => p.text.startsWith("Locaux"))?.visuals).toEqual(["postes"]);
  });

  it("ne recopie jamais une carte : aucun constat n'est un simple « Libellé : valeur »", () => {
    expect(texts.length).toBeGreaterThanOrEqual(4);
    for (const t of texts) expect(t).not.toMatch(/^[^:]+ : [\d\s,.-]+(k|M)?\s?€?\.?$/);
    expect(texts.some((t) => t.startsWith("Opérations"))).toBe(false);
  });

  it("dit les filtres actifs dans l'ouverture", () => {
    const filtered = pageBrief(tresorerie, dataOf, ["Mois : 2026-10", "Catégorie : Locaux", "sélection : Ventes"]).reading;
    expect(plain(filtered?.headline)).toContain("Trésorerie, août 2026 → oct. 2026 (filtré : Mois : 2026-10 ; Catégorie : Locaux…) :");
  });

  it("compare le maximum à la moyenne d'un même champ, jamais une moyenne à une somme", () => {
    const page: Page = {
      id: "c",
      name: "Clients et factures",
      visuals: [card("n", "Clients et factures", "Facture", "count", { compact: true }), card("t", "Montant HT", "Montant HT", "sum"), card("a", "Montant HT (moyenne)", "Montant HT", "avg"), card("m", "Montant HT (maximum)", "Montant HT", "max")],
      filters: [],
    };
    const values: Record<string, [string, number]> = { n: ["count(Facture)", 8], t: ["sum(Montant HT)", 13458], a: ["avg(Montant HT)", 1682], m: ["max(Montant HT)", 2650] };
    const r = pageBrief(page, (id) => {
      const v = values[id];
      return v ? { result: res([mea(v[0])], [{ [v[0]]: v[1] }]), error: null, trend: null } : undefined;
    }).reading;
    expect(plain(r?.headline)).toBe("Clients et factures : 8 en tout, Montant HT 13,5 k €, Montant HT (moyenne) 1,7 k €.");
    expect(r?.points.map((p) => plain(p.text))).toEqual(["« Montant HT (maximum) » (2,7 k €) vaut 1,6 fois « Montant HT (moyenne) » (1,7 k €)."]);
    expect(r?.points[0]?.visuals).toEqual(["m", "a"]);
  });

  it("sans carte, le constat le plus lourd fait l'ouverture et ne se répète pas", () => {
    const page: Page = { id: "s", name: "Suivi", visuals: [running, posts], filters: [] };
    const r = pageBrief(page, dataOf).reading;
    expect(plain(r?.headline)).toMatch(/^Suivi, sem\. 27\/07 → sem\. 26\/10 : « Solde cumulé » passe de/);
    expect(r?.points.map((p) => p.visuals)).toEqual([["postes"]]);
  });

  it("rien à comparer : pas de lecture (le résumé garde alors son comportement sans repli)", () => {
    const page: Page = { id: "o", name: "Compteur", visuals: [cards[3] as Visual], filters: [] };
    expect(pageBrief(page, dataOf).reading).toBeNull();
    expect(pageBrief(page, dataOf).visuals).toHaveLength(1);
  });

  it("garde au plus six constats, les plus lourds d'abord, un par visuel", () => {
    const many: Page = { id: "m", name: "Beaucoup", visuals: Array.from({ length: 9 }, (_, i) => ({ ...posts, id: `b${i}`, title: `Postes ${i}`, options: { ...eur, n: i } })), filters: [] };
    // Mêmes données sous des titres différents : faits identiques, donc un seul visuel retenu (pas de doublon envoyé).
    expect(pageAnalyses(many, () => dataOf("postes"))).toHaveLength(1);
    const r = pageReading(tresorerie, pageAnalyses(tresorerie, dataOf));
    expect(r?.points.length).toBeLessThanOrEqual(MAX_READING_POINTS);
    expect(new Set(r?.points.map((p) => p.visuals.join())).size).toBe(r?.points.length);
  });
});
