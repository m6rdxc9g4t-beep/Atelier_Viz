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

/** Espaces ordinaires à la place des insécables d'Intl et des guillemets : les attentes restent lisibles. */
const plain = (text: string | undefined) => (text ?? "").replace(/[\u00a0\u202f]/g, " ");
const expectFact = (facts: string[], text: string) => expect(facts.map(plain)).toContain(text);

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

  it("table de détail (plusieurs colonnes) : aucune de ses lignes ne part, seulement le nombre de lignes et les totaux", () => {
    const v = visual("table", { columns: [{ field: "Date" }, { field: "Libellé" }, { field: "Catégorie" }], values: [{ field: "Débit", agg: "sum", label: "Débit" }, { field: "Crédit", agg: "sum", label: "Crédit" }] }, { suffix: " €" });
    v.title = "Opérations";
    const row = (date: string, label: string, cat: string, debit: number, credit: number) => ({ Date: date, Libellé: label, Catégorie: cat, "sum(Débit)": debit, "sum(Crédit)": credit });
    const rows = [
      row("2026-08-01", "PRLV SEPA SCI DES TANNEURS LOYER ATELIER", "Locaux", 1150, 0),
      row("2026-08-03", "VIR SEPA MAISON LEBRUN FACTURE 2026-031", "Ventes", 0, 2400),
      row("2026-08-05", "CB LEROY MERLIN PARIS 11", "Matériel", 320, 0),
      row("2026-09-01", "PRLV SEPA SCI DES TANNEURS LOYER ATELIER", "Locaux", 1150, 0),
      row("2026-09-12", "URSSAF COTISATIONS T3", "Charges sociales", 900, 0),
    ];
    const a = analyzeVisual(v, data(res([dim("Date", "date"), dim("Libellé"), dim("Catégorie"), mea("sum(Débit)"), mea("sum(Crédit)")], rows)));
    expect(a.facts.map(plain)).toEqual(["5 lignes", "Total Débit : 3 520 €", "Total Crédit : 2 400 €"]);
    // Ni libellé d'opération, ni catégorie, ni date, ni montant d'une ligne : rien de ce qui identifie une opération.
    const sent = [...a.facts, ...a.notes.map((x) => x.text)].join(" | ");
    for (const leak of ["TANNEURS", "LEBRUN", "LEROY", "URSSAF", "Locaux", "Ventes", "01/08", "2026-08", "1 150", "1150"]) expect(plain(sent)).not.toContain(leak);
    // Le constat rédigé rapporte les totaux l'un à l'autre : de quoi donner une lecture calculée à la page.
    expect(plain(a.notes[0]?.text)).toBe("« Opérations » compte 5 lignes ; « Crédit » (2 400 €) y représente 68 % de « Débit » (3 520 €).");
  });

  it("table à plusieurs colonnes : un classement par la première colonne seulement s'il regroupe vraiment", () => {
    const v = visual("table", { columns: [{ field: "region" }, { field: "produit" }], values: ca });
    const row = (region: string, produit: string, value: number) => ({ region, produit, "sum(ca)": value });
    const grouped = [row("Nord", "A", 4), row("Nord", "B", 2), row("Sud", "A", 3), row("Sud", "B", 1), row("Nord", "C", 5), row("Sud", "C", 2)];
    const facts = visualFacts(v, data(res([dim("region"), dim("produit"), mea("sum(ca)")], grouped)));
    expect(facts).toContain("1er par region (Somme de ca) : Nord — 11");
    expect(facts).toContain("2e par region (Somme de ca) : Sud — 6");
    expect(facts.join(" ")).not.toMatch(/ [ABC] /); // jamais la deuxième colonne d'une ligne
    // Une valeur par ligne (ou presque) : la première colonne identifie les lignes, rien n'est classé.
    const detail = [row("Nord", "A", 4), row("Sud", "B", 2), row("Est", "C", 3), row("Est", "D", 1)];
    expect(visualFacts(v, data(res([dim("region"), dim("produit"), mea("sum(ca)")], detail)))).toEqual(["4 lignes", "Total Somme de ca : 10"]);
    // Une moyenne ne se regroupe pas : aucune ligne non plus.
    const avg = visual("table", { columns: [{ field: "region" }, { field: "produit" }], values: [{ field: "marge", agg: "avg" }] });
    const avgRows = grouped.map((r) => ({ region: r.region, produit: r.produit, "avg(marge)": r["sum(ca)"] }));
    expect(visualFacts(avg, data(res([dim("region"), dim("produit"), mea("avg(marge)")], avgRows)))).toEqual(["6 lignes"]);
  });

  it("table : un constat rédigé, même sans total ni ligne", () => {
    const one = visual("table", { columns: [{ field: "ville" }], values: ca }, { suffix: " €" });
    one.title = "Villes";
    const a = analyzeVisual(one, data(res([dim("ville"), mea("sum(ca)")], [{ ville: "Lyon", "sum(ca)": 500 }, { ville: "Brest", "sum(ca)": 900 }])));
    expect(plain(a.notes[0]?.text)).toBe("« Villes » compte 2 lignes, pour un total « Somme de ca » de 1 400 €, soit 700 € par ligne en moyenne.");
    const partial = analyzeVisual(one, data(res([dim("ville"), mea("sum(ca)")], [{ ville: "Lyon", "sum(ca)": 500 }, { ville: "Brest", "sum(ca)": 900 }], true)));
    expect(plain(partial.notes[0]?.text)).toBe("« Villes » compte plus de 2 lignes, pour un total « Somme de ca » de 1 400 €.");
    const bare = visual("table", { columns: [{ field: "ville" }] });
    bare.title = "Liste";
    expect(plain(analyzeVisual(bare, data(res([dim("ville")], [{ ville: "Lyon" }]))).notes[0]?.text)).toBe("« Liste » compte 1 ligne.");
  });

  it("nuage et carte à points : un constat rédigé chacun", () => {
    const s = visual("scatter", { details: [{ field: "magasin" }], x: [{ field: "surface", agg: "sum" }], y: [{ field: "ca", agg: "sum" }] });
    s.title = "CA et surface";
    const rows = [{ magasin: "Lyon", "sum(surface)": 300, "sum(ca)": 900 }, { magasin: "Brest", "sum(surface)": 200, "sum(ca)": 400 }];
    const a = analyzeVisual(s, data(res([dim("magasin"), mea("sum(surface)"), mea("sum(ca)")], rows)));
    expect(plain(a.notes[0]?.text)).toBe("« CA et surface » compare 2 points (un par magasin) ; Lyon a le plus haut « Somme de ca » (900).");
    const m = visual("pointmap", { latitude: [{ field: "lat" }], longitude: [{ field: "lon" }] });
    m.title = "Magasins";
    expect(plain(analyzeVisual(m, data(res([dim("lat"), dim("lon")], [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }]))).notes[0]?.text)).toBe("« Magasins » place 2 points sur la carte.");
  });

  it("ignore textes, segments, boutons, erreurs et visuels non chargés", () => {
    expect(visualFacts(visual("text", {}, { text: "Note" }), data(null))).toEqual([]);
    expect(visualFacts(visual("slicer", { field: [{ field: "region" }] }), data(res([dim("region")], [{ region: "Nord" }])))).toEqual([]);
    expect(visualFacts(visual("bar", { category: [{ field: "region" }], values: ca }), { result: null, error: "boom", trend: null })).toEqual([]);
  });
});


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
