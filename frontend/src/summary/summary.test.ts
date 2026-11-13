import type { Page, Visual } from "../types/report";
import type { QueryResult } from "../visuals/useQueryResult";
import { amount, analyzeVisual, isPeriodAxis, pageFacts, percent, quoted, spokenPeriod, visualFacts } from "./facts";
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

/** Espaces ordinaires à la place des insécables d'Intl et des guillemets : les attentes restent lisibles. */
const plain = (text: string | undefined) => (text ?? "").replace(/[\u00a0\u202f]/g, " ");
const expectFact = (facts: string[], text: string) => expect(facts.map(plain)).toContain(text);

describe("faits pour une lecture : sens, variation, concentration, rapport entre mesures", () => {
  const eur = { suffix: " €" };

  it("série : sens du début à la fin et écart de la fin à la moyenne", () => {
    const v = visual("line", { category: [{ field: "date", bin: "month" }], values: ca });
    const rows = [
      { "date|month": "2026-01-01", "sum(ca)": 100 },
      { "date|month": "2026-02-01", "sum(ca)": 80 },
      { "date|month": "2026-03-01", "sum(ca)": 120 },
      { "date|month": "2026-04-01", "sum(ca)": 180 },
    ];
    const facts = visualFacts(v, data(res([dim("date|month", "date"), mea("sum(ca)")], rows)));
    expectFact(facts, "Évolution du début à la fin : +80 %");
    expectFact(facts, "Sens du début à la fin : en hausse (2 hausses et 1 baisses d'une période à la suivante)");
    expectFact(facts, "Moyenne par période : 120 ; la fin est à +50 % de cette moyenne");
  });

  it("départ négatif : une variation en montant, jamais un pourcentage trompeur", () => {
    const v = visual("area", { category: [{ field: "date", bin: "month" }], values: ca }, eur);
    const rows = [
      { "date|month": "2026-01-01", "sum(ca)": -1200 },
      { "date|month": "2026-02-01", "sum(ca)": 900 },
      { "date|month": "2026-03-01", "sum(ca)": 3800 },
    ];
    const a = analyzeVisual(v, data(res([dim("date|month", "date"), mea("sum(ca)")], rows)));
    expectFact(a.facts, "Variation du début à la fin : +5 000 €");
    expect(a.facts.some((f) => f.startsWith("Évolution"))).toBe(false);
    expect(plain(a.notes[0]?.text)).toBe(plain(`${quoted("ca par date")} passe de -1 200 € (janv. 2026) à 3 800 € (mars 2026).`));
    expect(a.period).toBe("janv. 2026 → mars 2026");
  });

  it("mois écrits en texte (« 2026-08 ») : lus dans l'ordre du temps, pas comme un classement", () => {
    const v = visual("column", { category: [{ field: "Mois" }], values: [{ field: "Crédit", agg: "sum", label: "Recettes" }, { field: "Débit", agg: "sum", label: "Dépenses" }] }, eur);
    const rows = [
      { Mois: "2026-10", "sum(Crédit)": 5200, "sum(Débit)": 2800 },
      { Mois: "2026-08", "sum(Crédit)": 3600, "sum(Débit)": 2900 },
      { Mois: "2026-09", "sum(Crédit)": 4200, "sum(Débit)": 3400 },
    ];
    const a = analyzeVisual(v, data(res([dim("Mois"), mea("sum(Crédit)"), mea("sum(Débit)")], rows)));
    expect(a.facts[0]).toBe("Recettes — période : 2026-08 → 2026-10 (3 périodes)");
    expectFact(a.facts, "Évolution du début à la fin : +44 %");
    // Deuxième mesure : son évolution, et son rapport à la première (dépenses rapportées aux recettes).
    expectFact(a.facts, "Dépenses — début : 2026-08 — 2 900 € ; fin : 2026-10 — 2 800 € ; évolution : -3,4 %");
    expectFact(a.facts, "Dépenses rapporté à Recettes (totaux) : 70 %");
    expect(plain(a.notes[0]?.text)).toBe(plain(`${quoted("Recettes")} est en hausse : de 3 600 € (août 2026) à 5 200 € (oct. 2026), soit +44 % ; ${quoted("Dépenses")} est en baisse : de 2 900 € à 2 800 €, soit -3,4 %.`));
    expect(isPeriodAxis([{ raw: "Nord", label: "Nord", value: 1 }, { raw: "2026", label: "2026", value: 2 }])).toBe(false);
    // Le fait garde le libellé de l'axe ; le constat rédigé dit la période en clair.
    expect(a.period).toBe("août 2026 → oct. 2026");
    expect(["2026-08", "2026-T3", "2026Q1", "2026-S2", "2026", "2026-08-15", "Nord"].map(spokenPeriod)).toEqual(["août 2026", "T3 2026", "T1 2026", "S2 2026", "2026", "15/08/2026", "Nord"]);
  });

  it("classement : poids des trois premiers et écart du premier à la moyenne", () => {
    const v = visual("bar", { category: [{ field: "poste" }], values: ca }, eur);
    v.title = "Dépenses par poste";
    const rows = [
      { poste: "Locaux", "sum(ca)": 3500 },
      { poste: "Matériel", "sum(ca)": 2100 },
      { poste: "Charges", "sum(ca)": 1900 },
      { poste: "Repas", "sum(ca)": 300 },
      { poste: "Banque", "sum(ca)": 200 },
    ];
    const a = analyzeVisual(v, data(res([dim("poste"), mea("sum(ca)")], rows)));
    expectFact(a.facts, "Les 3 premiers ensemble : 94 % du total");
    expectFact(a.facts, "Moyenne par poste : 1 600 € ; le 1er vaut 2,2 fois cette moyenne");
    expect(plain(a.notes[0]?.text)).toBe(plain(`Locaux arrive en tête de ${quoted("Dépenses par poste")} avec 3 500 €, soit 44 % du total ; les 3 premiers (Locaux, Matériel, Charges) en font 94 %.`));
  });

  it("classement court : le suivant est dit en valeur (deux parts arrondies à part dépasseraient 100 %)", () => {
    const v = visual("donut", { category: [{ field: "statut" }], values: [{ field: "id", agg: "count" }] });
    v.title = "Répartition par statut";
    const rows = [{ statut: "Terminée", "count(id)": 7 }, { statut: "En cours", "count(id)": 1 }];
    const note = analyzeVisual(v, data(res([dim("statut"), mea("count(id)")], rows))).notes[0]?.text;
    expect(plain(note)).toBe(plain(`Terminée arrive en tête de ${quoted("Répartition par statut")} avec 7, soit 88 % du total ; En cours suit avec 1.`));
  });

  it("une seule valeur, ou une moyenne : la phrase le dit sans part", () => {
    const one = visual("bar", { category: [{ field: "poste" }], values: ca });
    expect(plain(analyzeVisual(one, data(res([dim("poste"), mea("sum(ca)")], [{ poste: "Ventes", "sum(ca)": 13 }]))).notes[0]?.text)).toBe(plain(`${quoted("ca par poste")} : une seule valeur, Ventes (13).`));
    const avg = visual("column", { category: [{ field: "region" }], values: [{ field: "marge", agg: "avg" }] });
    const note = analyzeVisual(avg, data(res([dim("region"), mea("avg(marge)")], [{ region: "Nord", "avg(marge)": 30 }, { region: "Sud", "avg(marge)": 20 }]))).notes[0]?.text;
    expect(plain(note)).toBe(plain(`${quoted("Moyenne de marge par region")} : Nord est le plus haut (30), Sud le plus bas (20) ; moyenne : 25.`));
  });

  it("KPI : la carte sans cible donne sa valeur, la cible donne une phrase d'écart", () => {
    const card = visual("kpi", { values: [{ field: "Crédit", agg: "sum", label: "Recettes" }] }, eur);
    expect(analyzeVisual(card, data(res([mea("sum(Crédit)")], [{ "sum(Crédit)": 12950 }]))).single).toMatchObject({ label: "Recettes", value: 12950, agg: "sum", field: "Crédit", unit: "| €" });
    const target = visual("kpi", { values: ca, target: [{ field: "objectif", agg: "sum" }] });
    target.title = "CA";
    const a = analyzeVisual(target, data(res([mea("sum(ca)"), mea("sum(objectif)")], [{ "sum(ca)": 900, "sum(objectif)": 1000 }])));
    expect(a.single).toBeUndefined();
    expect(plain(a.notes[0]?.text)).toBe(plain(`${quoted("CA")} : 900 pour une cible de 1 000, soit un écart défavorable de -10 %.`));
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
