import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { DatasetProfile } from "../types/dataset";
import type { Page, Visual } from "../types/report";
import { RANGE_SIDE_BY_SIDE } from "./fit";
import { KPI_VALUE_SIZE, KpiVisual, kpiValueSize } from "./data/KpiVisual";
import { MatrixVisual } from "./data/MatrixVisual";
import { TableVisual } from "./data/TableVisual";
import { NavigatorVisual } from "./interactive/NavigatorVisual";
import { SlicerVisual } from "./interactive/SlicerVisual";
import { VISUALS } from "./registry";
import type { VisualProps } from "./types";
import type { QueryResult } from "./useQueryResult";

// La mini-tendance du KPI lance sa propre requête : aucun réseau dans les tests.
vi.mock("./useQueryResult", () => ({
  useQueryResult: (req: unknown) => ({
    result: req ? { columns: [], truncated: false, rows: [{ "sum(Montant)": 1 }, { "sum(Montant)": 3 }, { "sum(Montant)": 2 }] } : null,
    loading: false,
    error: null,
  }),
}));

const dataset: DatasetProfile = {
  id: "ops",
  name: "Opérations",
  format: "csv",
  rows: 3,
  columns_count: 4,
  created_at: "2026-11-10T00:00:00Z",
  columns: [
    { name: "Date", type: "date", nulls: 0, distinct: 3, min: "2026-08-01", max: "2026-10-30", mean: null, top_values: [] },
    { name: "Catégorie", type: "string", nulls: 0, distinct: 2, min: null, max: null, mean: null, top_values: [] },
    { name: "Mois", type: "string", nulls: 0, distinct: 2, min: null, max: null, mean: null, top_values: [] },
    { name: "Montant", type: "number", nulls: 0, distinct: 3, min: 9, max: 1150, mean: 400, top_values: [] },
  ],
  sample: [],
};

const visual = (type: Visual["type"], roles: Visual["roles"], options: Visual["options"] = {}, title: string | null = "Titre"): Visual => ({
  id: "v1",
  type,
  title,
  layout: { x: 0, y: 0, w: 400, h: 300 },
  dataset_id: "ops",
  roles,
  options,
  filters: [],
});

const pages: Page[] = ["Trésorerie", "Dépenses", "Opérations", "Clients et factures"].map((name, i) => ({ id: `p${i}`, name, filters: [], visuals: [] }));

function props(v: Visual, result: QueryResult | null): VisualProps {
  return {
    visual: v,
    def: VISUALS[v.type],
    dataset,
    result,
    filters: [],
    selection: null,
    onSelect: () => {},
    setOptions: () => {},
    actions: { pages, pageId: "p0", reportName: "Rapport", goToPage: () => {}, resetFilters: () => {}, applyBookmark: () => false, activeFilters: [] },
    editing: false,
    parameters: {},
  };
}

const result = (rows: QueryResult["rows"]): QueryResult => ({ columns: [], truncated: false, rows });

/** Aucune ligne ni groupe de lignes n'est collant : seulement des cellules (Safari place mal un `tr` collant). */
function expectStickyCellsOnly(table: HTMLElement) {
  for (const el of table.querySelectorAll("tr, thead, tbody, tfoot")) expect(el.className, el.tagName).not.toMatch(/\bsticky\b/);
  const head = [...table.querySelectorAll("thead th")];
  const foot = [...table.querySelectorAll("tfoot th, tfoot td")];
  expect(head.length).toBeGreaterThan(0);
  expect(foot.length).toBeGreaterThan(0);
  for (const cell of head) expect(cell.className).toMatch(/\bsticky\b.*\bbg-surface\b|\bbg-surface\b.*\bsticky\b/);
  for (const cell of foot) {
    expect(cell.className).toMatch(/\bsticky\b/);
    expect(cell.className).toMatch(/-bottom-px/);
    expect(cell.className).toMatch(/\bbg-surface\b/);
  }
  // Bordures séparées : en `border-collapse`, le trait d'une cellule collante ne la suit pas.
  expect(table.className).toMatch(/border-separate/);
  expect(table.className).not.toMatch(/border-collapse/);
}

describe("tableau et matrice : en-tête et total figés", () => {
  const rows = [
    { "Catégorie": "Locaux", "sum(Montant)": 1150 },
    { "Catégorie": "Banque", "sum(Montant)": 9 },
  ];

  it("table : le total est collé en bas par ses cellules, les lignes défilent dans la zone du visuel", () => {
    const v = visual("table", { columns: [{ field: "Catégorie" }], values: [{ field: "Montant", agg: "sum" }] }, { totals: true, conditional: { "sum(Montant)": { bars: true } } });
    render(<TableVisual {...props(v, result(rows))} />);
    const table = screen.getByRole("table");
    expectStickyCellsOnly(table);
    expect(table.parentElement?.className).toMatch(/h-full/);
    expect(table.parentElement?.className).toMatch(/overflow-auto/);
    expect(screen.getByText("Total").closest("tfoot")).not.toBeNull();
  });

  it("table : la barre de données part du bord gauche de la cellule, pas du nombre", () => {
    const v = visual("table", { columns: [{ field: "Catégorie" }], values: [{ field: "Montant", agg: "sum" }] }, { totals: true, conditional: { "sum(Montant)": { bars: true } } });
    const { container } = render(<TableVisual {...props(v, result(rows))} />);
    const bars = [...container.querySelectorAll("[data-bar]")];
    expect(bars).toHaveLength(2);
    for (const bar of bars) {
      expect(bar.className).toMatch(/\bleft-1\b/);
      expect(bar.className).not.toMatch(/\bright-1\b/);
    }
    // La plus grande valeur remplit la cellule, la petite une fraction.
    expect((bars[0] as HTMLElement).style.width).toBe("calc(100% - 8px)");
  });

  it("matrice : mêmes règles, en-tête compris", () => {
    const v = visual("matrix", { rows: [{ field: "Catégorie" }], columns: [{ field: "Mois" }], values: [{ field: "Montant", agg: "sum" }] });
    const data = [
      { "Catégorie": "Locaux", Mois: "2026-08", "sum(Montant)": 1150 },
      { "Catégorie": "Banque", Mois: "2026-09", "sum(Montant)": 9 },
    ];
    render(<MatrixVisual {...props(v, result(data))} />);
    expectStickyCellsOnly(screen.getByRole("table"));
  });
});

describe("carte KPI", () => {
  it("la valeur ne rétrécit jamais ; la mini-tendance prend la place qui reste", () => {
    const v = visual("kpi", { values: [{ field: "Montant", agg: "sum" }], trend: [{ field: "Date", bin: "month" }] }, { compact: true, suffix: " €" });
    const { container } = render(<KpiVisual {...props(v, result([{ "sum(Montant)": 3800 }]))} />);
    const value = container.querySelector("[data-kpi-value]") as HTMLElement;
    expect(value.textContent).toMatch(/^3,8\sk\s€$/);
    expect(value.className).toMatch(/\bshrink-0\b/);
    expect(value.title).toBe(value.textContent);
    // Taille bornée par la hauteur de la carte, pas seulement par sa largeur.
    expect(KPI_VALUE_SIZE).toMatch(/min\(max\(\d+cqw, [\d.]+rem\), \d+cqh\)/);
    const trend = container.querySelector("[data-kpi-trend]") as HTMLElement;
    expect(trend.className).toMatch(/\bmin-h-0\b/);
    expect(trend.className).toMatch(/\bshrink\b/);
    expect(trend.className).not.toMatch(/\bh-10\b/);
    // L'ordre garde la valeur au-dessus de la courbe.
    expect(value.compareDocumentPosition(trend) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("la valeur garde 24 px dans une carte étroite du gabarit, avec ou sans mini-tendance", () => {
    expect(KPI_VALUE_SIZE).toBe("clamp(1.125rem, min(max(8cqw, 1.5rem), 44cqh), 3.25rem)");
    // Quatre KPI par rangée : contenu d'environ 215 × 64 px (rangée de 116 px), 56 px dans l'ancienne rangée de 108 px.
    expect(kpiValueSize(215, 64)).toBe(24);
    expect(kpiValueSize(215, 56)).toBe(24);
    // Une ligne de 24 px (interligne 1,25) laisse au moins 18 px à la courbe, sous l'écart de 4 px.
    for (const h of [56, 64]) expect(h - kpiValueSize(215, h) * 1.25 - 4).toBeGreaterThanOrEqual(18);
    // Carte large : la valeur grandit avec la largeur, sans dépasser la hauteur ni 52 px.
    expect(kpiValueSize(500, 200)).toBe(40);
    expect(kpiValueSize(900, 300)).toBe(52);
    // Carte large et basse : la ligne de la valeur et celle de l'écart à la cible (20 px) tiennent dans la hauteur.
    for (const h of [48, 56, 64, 90]) expect(kpiValueSize(600, h) * 1.25 + 20).toBeLessThanOrEqual(h);
    // Carte minuscule : jamais sous 18 px.
    expect(kpiValueSize(120, 30)).toBe(18);
  });

  it("sans champ de tendance, pas de courbe", () => {
    const v = visual("kpi", { values: [{ field: "Montant", agg: "sum" }] });
    const { container } = render(<KpiVisual {...props(v, result([{ "sum(Montant)": 41 }]))} />);
    expect(container.querySelector("[data-kpi-trend]")).toBeNull();
  });
});

describe("segment de plage", () => {
  it("deux champs de date nommés, l'un sous l'autre tant que la largeur manque", () => {
    const v = visual("slicer", { field: [{ field: "Date" }] }, { style: "range" });
    render(<SlicerVisual {...props(v, result([{ "min(Date)": "2026-08-01", "max(Date)": "2026-10-30" }]))} />);
    const from = screen.getByLabelText("Du") as HTMLInputElement;
    const to = screen.getByLabelText("Au") as HTMLInputElement;
    expect(from.type).toBe("date");
    expect(to.min).toBe("2026-08-01");
    const grid = from.closest("label")?.parentElement as HTMLElement;
    // Une colonne par défaut ; deux seulement à partir de la largeur de deux champs entiers.
    expect(grid.className).toMatch(/\bgrid-cols-1\b/);
    expect(grid.className).toContain(`@[${RANGE_SIDE_BY_SIDE}px]:grid-cols-2`);
    expect(grid.parentElement?.className).toMatch(/@container/);
    // Le champ prend toute la largeur à côté de son libellé.
    expect(from.className).toMatch(/\bflex-1\b/);
    expect(screen.getByText(/Données : 01\/08\/2026 → 30\/10\/2026/)).toBeInTheDocument();
  });
});

describe("navigateur de pages", () => {
  it("chaque onglet part de la largeur de son nom et garde le nom entier en info-bulle", () => {
    const v = visual("navigator", {}, { orientation: "horizontal", look: "tabs" }, "");
    render(<NavigatorVisual {...props(v, null)} />);
    const tabs = screen.getAllByRole("button");
    expect(tabs.map((t) => t.textContent)).toEqual(["Trésorerie", "Dépenses", "Opérations", "Clients et factures"]);
    for (const tab of tabs) {
      expect(tab.className).toMatch(/\bflex-auto\b/);
      expect(tab.className).not.toMatch(/\bflex-1\b/);
      expect(tab.className).toMatch(/\btruncate\b/);
      expect(tab.title).toBe(tab.textContent);
    }
    expect(tabs[0]?.getAttribute("aria-current")).toBe("page");
  });
});
