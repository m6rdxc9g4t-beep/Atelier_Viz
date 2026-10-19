import type { Page, Visual } from "../types/report";
import type { QueryResult } from "../visuals/useQueryResult";
import { amount, pageFacts, percent, visualFacts } from "./facts";
import { summaryNotes, summaryText } from "./pageSummary";

let n = 0;
const visual = (type: Visual["type"], roles: Visual["roles"], options: Visual["options"] = {}): Visual => ({
  id: `v${++n}`,
  type,
  title: null,
  layout: { x: 0, y: 0, w: 8, h: 8 },
  dataset_id: "ds",
  roles,
  options,
  filters: [],
});

type Col = QueryResult["columns"][number];
const dim = (key: string, type: Col["type"] = "string"): Col => ({ key, field: key.split("|")[0] ?? key, role: "dimension", type });
const mea = (key: string): Col => ({ key, field: null, role: "measure", type: "number" });
const res = (columns: Col[], rows: QueryResult["rows"], truncated = false): QueryResult => ({ columns, rows, truncated });
const data = (result: QueryResult | null, trend: QueryResult | null = null) => ({ result, error: null, trend });

const ca = [{ field: "ca", agg: "sum" as const }];

describe("formats des faits", () => {
  it("écrit les montants et pourcentages comme à l'écran", () => {
    expect(amount(4_412_345, {})).toBe("4,4 M");
    expect(amount(974_000, {})).toBe("974 k");
    expect(amount(812, {})).toBe("812");
    expect(percent(0.224)).toBe("22 %");
    expect(percent(0.045)).toBe("4,5 %");
    expect(percent(0.48, true)).toBe("+48 %");
    expect(percent(-0.12, true)).toBe("-12 %");
  });
});

describe("faits d'un visuel", () => {
  it("classement : total, trois premiers avec leur part, dernier", () => {
    const v = visual("bar", { category: [{ field: "region" }], values: ca });
    const rows = [
      { region: "Nord", "sum(ca)": 500 },
      { region: "Sud", "sum(ca)": 300 },
      { region: "Est", "sum(ca)": 150 },
      { region: "Ouest", "sum(ca)": 50 },
    ];
    const facts = visualFacts(v, data(res([dim("region"), mea("sum(ca)")], rows)));
    expect(facts[0]).toBe("Somme de ca par region : 4 valeurs");
    expect(facts).toContain("Total : 1 000");
    expect(facts).toContain("1er : Nord — 500 (50 % du total)");
    expect(facts).toContain("Dernier : Ouest — 50 (5,0 % du total)");
  });

  it("série temporelle : période, évolution, extrêmes, total", () => {
    const v = visual("line", { category: [{ field: "date", bin: "month" }], values: ca });
    const rows = [
      { "date|month": "2026-03-01", "sum(ca)": 640_000 },
      { "date|month": "2026-01-01", "sum(ca)": 382_000 },
      { "date|month": "2026-09-01", "sum(ca)": 566_000 },
    ];
    const facts = visualFacts(v, data(res([dim("date|month", "date"), mea("sum(ca)")], rows)));
    expect(facts[0]).toBe("Somme de ca — période : janv. 2026 → sept. 2026 (3 périodes)");
    expect(facts).toContain("Évolution du début à la fin : +48 %");
    expect(facts).toContain("Maximum : mars 2026 — 640 k ; minimum : janv. 2026 — 382 k");
  });

  it("avec légende : répartition par la 2e dimension", () => {
    const v = visual("column", { category: [{ field: "region" }], series: [{ field: "produit" }], values: ca });
    const rows = [
      { region: "Nord", produit: "A", "sum(ca)": 30 },
      { region: "Nord", produit: "B", "sum(ca)": 10 },
      { region: "Sud", produit: "A", "sum(ca)": 60 },
    ];
    const facts = visualFacts(v, data(res([dim("region"), dim("produit"), mea("sum(ca)")], rows)));
    expect(facts).toContain("1er : Sud — 60 (60 % du total)");
    expect(facts).toContain("Par produit : A — 90 (90 %), B — 10 (10 %)");
  });

  it("moyenne : ni total ni part (non additive)", () => {
    const v = visual("column", { category: [{ field: "region" }], values: [{ field: "marge", agg: "avg" }] });
    const facts = visualFacts(v, data(res([dim("region"), mea("avg(marge)")], [{ region: "Nord", "avg(marge)": 30.5 }, { region: "Sud", "avg(marge)": 28.1 }])));
    expect(facts.some((f) => f.startsWith("Total"))).toBe(false);
    expect(facts).toContain("1er : Nord — 30,5");
  });

  it("KPI : valeur, cible, écart favorable ou non, tendance", () => {
    const v = visual("kpi", { values: ca, target: [{ field: "objectif", agg: "sum" }], trend: [{ field: "date", bin: "month" }] }, { higherIsBetter: false });
    const trend = res([dim("date|month", "date"), mea("sum(ca)")], [
      { "date|month": "2026-01-01", "sum(ca)": 100 },
      { "date|month": "2026-02-01", "sum(ca)": 150 },
    ]);
    const facts = visualFacts(v, data(res([mea("sum(ca)"), mea("sum(objectif)")], [{ "sum(ca)": 1100, "sum(objectif)": 1000 }]), trend));
    expect(facts[0]).toBe("Somme de ca : 1 100");
    expect(facts[1]).toBe("Cible : 1 000 ; écart : +10 % (défavorable)");
    expect(facts).toContain("Évolution du début à la fin : +50 %");
  });

  it("matrice : sous-totaux du premier niveau (GROUPING SETS)", () => {
    const v = visual("matrix", { rows: [{ field: "region" }, { field: "produit" }], values: ca });
    const rows = [
      { region: null, produit: null, "sum(ca)": 10, __grouping: 3 },
      { region: "Nord", produit: null, "sum(ca)": 6, __grouping: 1 },
      { region: "Nord", produit: "A", "sum(ca)": 6, __grouping: 0 },
      { region: "Sud", produit: null, "sum(ca)": 4, __grouping: 1 },
    ];
    const facts = visualFacts(v, data(res([dim("region"), dim("produit"), mea("sum(ca)")], rows)));
    expect(facts).toContain("Total : 10");
    expect(facts).toContain("1er : Nord — 6 (60 % du total)");
  });

  it("table : nombre de lignes, totaux, premières lignes", () => {
    const v = visual("table", { columns: [{ field: "ville" }], values: ca });
    const facts = visualFacts(v, data(res([dim("ville"), mea("sum(ca)")], [{ ville: "Lyon", "sum(ca)": 5 }, { ville: "Brest", "sum(ca)": 9 }], true)));
    expect(facts[0]).toBe("2 (ou plus) lignes");
    expect(facts).toContain("1er (Somme de ca) : Brest — 9");
  });

  it("ignore textes, segments, boutons, erreurs et visuels non chargés", () => {
    expect(visualFacts(visual("text", {}, { text: "Note" }), data(null))).toEqual([]);
    expect(visualFacts(visual("slicer", { field: [{ field: "region" }] }), data(res([dim("region")], [{ region: "Nord" }])))).toEqual([]);
    expect(visualFacts(visual("bar", { category: [{ field: "region" }], values: ca }), { result: null, error: "boom", trend: null })).toEqual([]);
  });
});

describe("page", () => {
  it("garde les visuels chiffrés, avec leur titre", () => {
    const a = visual("kpi", { values: ca });
    a.title = "CA total";
    const b = visual("text", {}, { text: "x" });
    const page: Page = { id: "p", name: "Vue", visuals: [a, b], filters: [] };
    const facts = pageFacts(page, (id) => (id === a.id ? data(res([mea("sum(ca)")], [{ "sum(ca)": 12 }])) : data(null)));
    expect(facts).toEqual([{ id: a.id, title: "CA total", type: "kpi", facts: ["Somme de ca : 12"] }]);
  });

  it("met en forme la synthèse pour une zone de texte et pour les notes", () => {
    const s = { headline: "CA en hausse", points: [{ text: "Le Nord mène.", visuals: [] }, { text: "Mars est le meilleur mois.", visuals: [] }] };
    expect(summaryText(s)).toBe("**CA en hausse**\n- Le Nord mène.\n- Mars est le meilleur mois.");
    expect(summaryNotes(s)[1]).toBe("CA en hausse");
  });
});
