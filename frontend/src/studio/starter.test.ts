import { describe, expect, it } from "vitest";

import type { ColumnProfile, DatasetProfile } from "../types/dataset";
import type { Page, Visual } from "../types/report";
import { kpiMinHeight, navigatorWidth, rangeSlicerMinHeight, textWidth } from "../visuals/fit";
import { VISUALS } from "../visuals/registry";
import { analyze, shortName, starterPages, storyPages } from "./starter";

const col = (name: string, type: ColumnProfile["type"], distinct: number, extra: Partial<ColumnProfile> = {}): ColumnProfile => ({
  name,
  type,
  nulls: 0,
  distinct,
  min: null,
  max: null,
  mean: null,
  top_values: [],
  ...extra,
});

const profile = (id: string, name: string, rows: number, columns: ColumnProfile[]): DatasetProfile => ({
  id,
  name,
  format: "atelier_table",
  rows,
  columns_count: columns.length,
  created_at: "2026-11-10T00:00:00Z",
  columns,
  sample: [],
});

const months = [{ value: "2026-08", count: 10 }, { value: "2026-09", count: 8 }, { value: "2026-10", count: 6 }];
const operations = profile("ops000000001", "Rénovation Urbaine 2026 — opérations août-oct. 2026", 24, [
  col("Date", "date", 20, { min: "2026-08-03", max: "2026-10-28" }),
  col("Libellé", "string", 22),
  col("Débit", "number", 15, { min: 18, max: 16000 }),
  col("Crédit", "number", 3, { min: 50000, max: 50000 }),
  col("Montant", "number", 18, { min: -16000, max: 50000 }),
  col("Catégorie", "string", 9),
  col("Mois", "string", 3, { top_values: months }),
]);
const lots = profile("lots00000001", "Rénovation Urbaine 2026 — Planning & Lots", 6, [
  col("Lot / Tâche", "string", 6, { top_values: [{ value: "Gros œuvre", count: 1 }] }),
  col("Statut", "string", 4),
  col("Coût HT", "number", 6, { min: 15000, max: 45000 }),
  col("Responsable", "string", 3),
  col("Échéance", "date", 6, { min: "2026-11-30", max: "2027-02-28" }),
  col("Avancement", "number", 5, { min: 0, max: 1 }),
]);
const commandes = profile("cmd000000001", "App E-Commerce v2 — Commandes", 413, [
  col("Date", "date", 90, { min: "2026-08-01", max: "2026-10-31" }),
  col("Commande", "string", 413),
  col("Premier produit", "string", 6),
  col("Articles", "number", 5, { min: 1, max: 5 }),
  col("Montant TTC", "number", 300, { min: 12, max: 180 }),
  col("Canal", "string", 3),
]);
const ventes = profile("ventes000001", "ventes_2026.csv", 573, [
  col("date", "date", 200, { min: "2026-01-05", max: "2026-09-26" }),
  col("region", "string", 5),
  col("produit", "string", 4),
  col("quantite", "number", 10, { min: 1, max: 10 }),
  col("prix_unitaire", "number", 50, { min: 50, max: 3000 }),
  col("chiffre_affaires", "number", 500, { min: 50, max: 30000 }),
  col("responsable", "string", 5, { related: "regions" }),
]);

const all = (pages: Page[]) => pages.flatMap((p) => p.visuals);
const content = (p: Page) => p.visuals.filter((v) => !(v.type === "text" && v.options.panel === true));
const overlaps = (a: Visual["layout"], b: Visual["layout"]) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Règles communes : rôles connus, champs existants, page 1280 × 720, aucun chevauchement. */
function checkPages(pages: Page[], datasets: DatasetProfile[]) {
  for (const page of pages) {
    expect(page.size).toEqual({ width: 1280, height: 720 });
    const visuals = content(page);
    for (const v of page.visuals) {
      expect(v.layout.x).toBeGreaterThanOrEqual(0);
      expect(v.layout.y).toBeGreaterThanOrEqual(0);
      expect(v.layout.x + v.layout.w).toBeLessThanOrEqual(1280);
      expect(v.layout.y + v.layout.h).toBeLessThanOrEqual(720);
      const ds = datasets.find((d) => d.id === v.dataset_id);
      for (const [roleId, bindings] of Object.entries(v.roles)) {
        expect(VISUALS[v.type].roles.some((r) => r.id === roleId), `${v.type}.${roleId}`).toBe(true);
        for (const b of bindings) expect(ds?.columns.some((c) => c.name === b.field), `${v.type} ${b.field}`).toBe(true);
      }
      for (const f of v.filters) expect(ds?.columns.some((c) => c.name === f.field)).toBe(true);
    }
    for (let i = 0; i < visuals.length; i++) {
      for (let j = i + 1; j < visuals.length; j++) {
        expect(overlaps(visuals[i]!.layout, visuals[j]!.layout), `${page.name} : ${visuals[i]!.type} / ${visuals[j]!.type}`).toBe(false);
      }
    }
    // Barre de filtres : panneau, segments, réinitialisation.
    expect(page.visuals.some((v) => v.type === "text" && v.options.panel === true)).toBe(true);
    expect(page.visuals.some((v) => v.type === "button" && v.options.action === "reset")).toBe(true);
  }
  // Navigateur sur chaque page dès qu'il y en a plusieurs.
  for (const page of pages) expect(page.visuals.some((v) => v.type === "navigator")).toBe(pages.length > 1);
  checkRoom(pages);
}

/** Chaque visuel a la place de son contenu : rien de rogné à l'ouverture du rapport (voir `visuals/fit.ts`). */
function checkRoom(pages: Page[]) {
  const names = pages.map((p) => p.name);
  for (const page of pages) {
    for (const v of page.visuals) {
      const where = `${page.name} : ${v.type} « ${v.title ?? ""} »`;
      // KPI : titre, valeur et, s'il y en a une, mini-tendance l'un sous l'autre.
      if (v.type === "kpi") expect(v.layout.h, where).toBeGreaterThanOrEqual(kpiMinHeight(!!v.roles.trend?.length));
      // Plage de dates : les deux champs montrent l'année entière (l'un sous l'autre dans la colonne des filtres).
      if (v.type === "slicer" && v.options.style === "range") expect(v.layout.h, where).toBeGreaterThanOrEqual(rangeSlicerMinHeight(v.layout.w));
      // Navigateur : aucun nom de page abrégé.
      if (v.type === "navigator") expect(v.layout.w, where).toBeGreaterThanOrEqual(navigatorWidth(names));
    }
    // Titre de la page : sur une seule ligne, à gauche du navigateur.
    const title = page.visuals.find((v) => v.type === "text" && !v.options.panel);
    const text = String(title?.options.text ?? "");
    const [bold = "", rest = ""] = text.replace(/^\*\*/, "").split("**");
    expect(textWidth(bold, 18, true) + textWidth(rest, 18), `${page.name} : titre`).toBeLessThanOrEqual((title?.layout.w ?? 0) - 12);
  }
}

describe("analyse des jeux", () => {
  it("reconnaît la nature de chaque jeu et le rôle des colonnes", () => {
    const ops = analyze(operations);
    expect(ops.kind).toBe("flows");
    expect([ops.debit?.name, ops.credit?.name, ops.signed?.name, ops.period?.name]).toEqual(["Débit", "Crédit", "Montant", "Mois"]);
    expect(ops.dims.map((c) => c.name)).toEqual(["Catégorie"]); // « Libellé » n'est pas un regroupement

    const l = analyze(lots);
    expect(l.kind).toBe("list");
    expect([l.main?.name, l.percent?.name, l.status?.name, l.name?.name]).toEqual(["Coût HT", "Avancement", "Statut", "Lot / Tâche"]);

    const c = analyze(commandes);
    expect(c.kind).toBe("events");
    expect(c.main?.name).toBe("Montant TTC");

    // Un prix unitaire n'est jamais la mesure principale ; les colonnes d'un jeu lié passent après.
    const v = analyze(ventes);
    expect(v.main?.name).toBe("chiffre_affaires");
    expect(v.dims[0]?.related).toBeFalsy();
  });

  it("donne un nom court aux jeux d'une histoire", () => {
    expect(shortName("Arpège Courtage — Contrats")).toBe("Contrats");
    expect(shortName("Arpège Courtage — opérations août-oct. 2026")).toBe("Opérations");
    expect(shortName("ventes_2026.csv")).toBe("ventes_2026");
  });
});

describe("rapport de démarrage", () => {
  it("opérations : trésorerie, dépenses et liste, sans secteurs sur des montants signés", () => {
    const pages = starterPages(operations);
    checkPages(pages, [operations]);
    expect(pages.map((p) => p.name)).toEqual(["Vue d'ensemble", "Dépenses", "Opérations"]);
    const kpis = pages[0]!.visuals.filter((v) => v.type === "kpi").map((v) => v.title);
    expect(kpis).toEqual(["Recettes", "Dépenses", "Solde de la période", "Opérations"]);
    for (const v of all(pages).filter((x) => x.type === "donut" || x.type === "pie")) {
      expect(v.roles.values?.[0]?.field).not.toBe("Montant");
    }
    // Les dépenses par catégorie ne portent que sur les lignes de débit.
    const spend = pages[0]!.visuals.find((v) => v.title === "Dépenses par catégorie");
    expect(spend?.filters).toEqual([{ field: "Débit", op: "gt", values: [0] }]);
    // Mois en vignettes, catégorie en liste déroulante.
    const slicers = pages[0]!.visuals.filter((v) => v.type === "slicer").map((v) => [v.roles.field?.[0]?.field, v.options.style]);
    expect(slicers).toEqual([["Date", "range"], ["Mois", "tiles"], ["Catégorie", "dropdown"]]);
  });

  it("liste : classement, statuts, avancement en pourcentage d'une fraction", () => {
    const pages = starterPages(lots);
    checkPages(pages, [lots]);
    expect(pages).toHaveLength(1);
    const visuals = pages[0]!.visuals;
    expect(visuals.find((v) => v.type === "donut")?.roles.category?.[0]?.field).toBe("Statut");
    const progress = visuals.find((v) => v.type === "bar" && v.roles.values?.[0]?.field === "Avancement");
    expect(progress?.roles.values?.[0]?.agg).toBe("avg");
    expect(progress?.options.fraction).toBe(true);
  });

  it("événements : évolution par canal, moyenne, analyse croisée", () => {
    const pages = starterPages(commandes);
    checkPages(pages, [commandes]);
    expect(pages.map((p) => p.name)).toEqual(["Vue d'ensemble", "Analyse"]);
    const line = pages[0]!.visuals.find((v) => v.type === "line");
    expect(line?.roles.series?.[0]?.field).toBe("Canal");
    expect(line?.roles.category?.[0]).toEqual({ field: "Date", bin: "week" });
    expect(pages[1]!.visuals.some((v) => v.type === "matrix")).toBe(true);
  });

  it("prix unitaire moyenné, carte des régions dans l'analyse", () => {
    const pages = starterPages(ventes);
    checkPages(pages, [ventes]);
    const prix = all(pages).flatMap((v) => Object.values(v.roles).flat()).filter((b) => b.field === "prix_unitaire");
    for (const b of prix) expect(b.agg).not.toBe("sum");
    expect(pages[1]!.visuals.find((v) => v.type === "map")?.options.geo).toBe("fr-regions");
  });
});

describe("parts d'une allocation", () => {
  it("compare cible et réalisé au lieu d'en faire la moyenne", () => {
    const allocation = profile("alloc0000001", "Lemaire Patrimoine — Allocation cible", 4, [
      col("Classe d'actifs", "string", 4),
      col("Cible", "number", 4, { min: 0.1, max: 0.4, mean: 0.25 }),
      col("Réelle au 30/09", "number", 4, { min: 0.08, max: 0.49, mean: 0.25 }),
      col("Valeur au 31/10", "number", 4, { min: 72000, max: 302400, mean: 180000 }),
    ]);
    const a = analyze(allocation);
    expect(a.shares.map((c) => c.name)).toEqual(["Cible", "Réelle au 30/09"]);
    expect(a.percent).toBeUndefined();
    expect(a.main?.name).toBe("Valeur au 31/10");
    const pages = starterPages(allocation);
    checkPages(pages, [allocation]);
    const compare = pages[0]!.visuals.find((v) => v.title === "Cible et réalisé par classe d'actifs");
    expect(compare?.roles.values?.map((b) => b.field)).toEqual(["Cible", "Réelle au 30/09"]);
    expect(compare?.options.fraction).toBe(true);
    // Aucune moyenne de parts en KPI ; un segment sur les classes faute d'autre regroupement.
    expect(pages[0]!.visuals.filter((v) => v.type === "kpi").some((v) => v.roles.values?.[0]?.field === "Cible")).toBe(false);
    expect(pages[0]!.visuals.find((v) => v.type === "slicer")?.roles.field?.[0]?.field).toBe("Classe d'actifs");
  });
});

describe("place du contenu", () => {
  const factures = profile("fact00000001", "Studio Garance — Clients et factures", 8, [
    col("Facture", "string", 8, { top_values: [{ value: "2026-043", count: 1 }] }),
    col("Statut", "string", 2),
    col("Client", "string", 4),
    col("Émise le", "date", 8, { min: "2026-07-28", max: "2026-10-28" }),
    col("Montant HT", "number", 6, { min: 800, max: 2650 }),
  ]);

  it("Studio Garance : KPI à mini-tendance, dates et navigateur ont la place de leur contenu", () => {
    const pages = storyPages("Studio Garance", [operations, factures]);
    checkPages(pages, [operations, factures]);
    expect(pages.map((p) => p.name)).toEqual(["Trésorerie", "Dépenses", "Opérations", "Clients et factures"]);
    // Le KPI « Solde de la période » porte une mini-tendance : sa rangée est assez haute pour elle.
    const solde = pages[0]!.visuals.find((v) => v.title === "Solde de la période");
    expect(solde?.roles.trend?.[0]?.field).toBe("Date");
    expect(solde!.layout.h).toBeGreaterThanOrEqual(kpiMinHeight(true));
    // Même navigateur, à la même place, sur toutes les pages.
    const navs = pages.map((p) => p.visuals.find((v) => v.type === "navigator")!.layout);
    for (const n of navs) expect(n).toEqual(navs[0]);
  });

  it("un titre très long garde sa ligne : le navigateur lui cède de la place sans disparaître", () => {
    const pages = storyPages("Coopérative agricole des Alpilles et du pays d'Arles — exercice 2026", [operations]);
    const nav = pages[0]!.visuals.find((v) => v.type === "navigator")!;
    const title = pages[0]!.visuals.find((v) => v.type === "text" && !v.options.panel)!;
    expect(nav.layout.w).toBeGreaterThanOrEqual(96 * pages.length);
    expect(title.layout.x + title.layout.w).toBeLessThanOrEqual(nav.layout.x);
    expect(title.layout.w).toBeGreaterThan(300);
  });
});

describe("rapport d'une histoire", () => {
  it("réunit les jeux de l'histoire derrière un même navigateur", () => {
    const pages = storyPages("Rénovation Urbaine 2026", [operations, lots, commandes]);
    checkPages(pages, [operations, lots, commandes]);
    expect(pages.map((p) => p.name)).toEqual(["Trésorerie", "Dépenses", "Opérations", "Planning & Lots", "Commandes"]);
    // Chaque page ne filtre que son propre jeu.
    for (const page of pages) {
      const ids = new Set(page.visuals.filter((v) => v.dataset_id).map((v) => v.dataset_id));
      expect(ids.size).toBe(1);
    }
    const title = pages[3]!.visuals.find((v) => v.type === "text" && !v.options.panel);
    expect(title?.options.text).toBe("**Rénovation Urbaine 2026** — Planning & Lots");
  });
});
