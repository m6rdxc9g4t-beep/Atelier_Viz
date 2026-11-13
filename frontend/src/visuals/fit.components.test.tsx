import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { DatasetProfile } from "../types/dataset";
import type { Page, Visual } from "../types/report";
import { RANGE_SIDE_BY_SIDE, navigatorTabMinCss, navigatorTabWidth } from "./fit";
import { KPI_VALUE_SIZE, KpiVisual, kpiValueSize } from "./data/KpiVisual";
import { MatrixVisual } from "./data/MatrixVisual";
import { TableVisual, columnFit } from "./data/TableVisual";
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

/**
 * En-tête collé en haut par ses cellules ; plus rien n'est collé en bas : sous le `transform: scale` du canvas,
 * Safari pose un `sticky` + `bottom` à hauteur × zoom (le Total au milieu du tableau, des lignes dessous).
 */
function expectPinnedTotal(container: HTMLElement) {
  const table = screen.getByRole("table");
  for (const el of table.querySelectorAll("tr, thead, tbody, tfoot")) expect(el.className, el.tagName).not.toMatch(/\bsticky\b/);
  const head = [...table.querySelectorAll("thead th")];
  expect(head.length).toBeGreaterThan(0);
  for (const cell of head) expect(cell.className).toMatch(/\bsticky\b.*\bbg-surface\b|\bbg-surface\b.*\bsticky\b/);
  for (const el of container.querySelectorAll("*")) expect(String(el.getAttribute("class") ?? ""), el.tagName).not.toMatch(/(^|\s)-?bottom-/);
  // Bordures séparées : en `border-collapse`, le trait d'une cellule collante ne la suit pas.
  expect(table.className).toMatch(/border-separate/);
  expect(table.className).not.toMatch(/border-collapse/);

  // Zone défilante (en-tête + lignes), puis le total dessous, hors défilement : rien ne se dessine sous lui.
  const scroll = container.querySelector("[data-table-scroll]") as HTMLElement;
  const foot = container.querySelector("[data-table-total]") as HTMLElement;
  expect(scroll.contains(table)).toBe(true);
  expect(scroll.className).toMatch(/\boverflow-auto\b/);
  expect(scroll.className).toMatch(/\bmin-h-0\b/);
  expect(scroll.contains(foot)).toBe(false);
  expect(scroll.nextElementSibling).toBe(foot);
  expect(foot.nextElementSibling).toBeNull();
  expect(foot.className).toMatch(/\bshrink-0\b/);
  expect(foot.className).not.toMatch(/\bsticky\b/);
  expect(scroll.parentElement?.className).toMatch(/\bh-full\b/);
  expect(scroll.parentElement?.className).toMatch(/\bflex-col\b/);

  // Le total reste une ligne du tableau (sans hauteur) ; le pied visible en est le double, ignoré des lecteurs d'écran.
  const semantic = [...table.querySelectorAll("tfoot tr > *")];
  const shown = [...foot.querySelectorAll("td")];
  expect(semantic.length).toBeGreaterThan(0);
  expect(shown.map((c) => c.textContent)).toEqual(semantic.map((c) => c.textContent));
  expect(semantic[0]?.tagName).toBe("TH");
  expect(semantic[0]?.getAttribute("scope")).toBe("row");
  for (const cell of semantic) expect(cell.firstElementChild?.className).toMatch(/\bh-px\b.*\boverflow-hidden\b/);
  // La cellule coupe le pixel de cette ligne : il ne dépasse pas du tableau, la zone ne défile pas de 1 px
  // (sous Windows, une barre de défilement apparaissait sur un tableau qui tient en entier).
  for (const cell of semantic) expect(cell.className).toMatch(/\boverflow-hidden\b/);
  expect(foot.getAttribute("aria-hidden")).toBe("true");
  expect(table.closest("[aria-hidden]")).toBeNull();
  return { table, foot, shown };
}

describe("tableau et matrice : en-tête figé, total sous la zone défilante", () => {
  const rows = [
    { "Catégorie": "Locaux", "sum(Montant)": 1150 },
    { "Catégorie": "Banque", "sum(Montant)": 9 },
  ];

  it("table : le total est hors de la zone défilante, jamais collé en bas", () => {
    const v = visual("table", { columns: [{ field: "Catégorie" }], values: [{ field: "Montant", agg: "sum" }] }, { totals: true, conditional: { "sum(Montant)": { bars: true } } });
    const { container } = render(<TableVisual {...props(v, result(rows))} />);
    const { shown } = expectPinnedTotal(container);
    expect(shown.map((c) => c.textContent?.replace(/\s/g, " "))).toEqual(["Total", "1 159"]);
    expect(shown[1]?.className).toMatch(/\btext-right\b.*\btabular-nums\b/);
  });

  it("table : sans l'option Total, ni pied ni ligne de total", () => {
    const v = visual("table", { columns: [{ field: "Catégorie" }], values: [{ field: "Montant", agg: "sum" }] }, { totals: false });
    const { container } = render(<TableVisual {...props(v, result(rows))} />);
    expect(container.querySelector("[data-table-total]")).toBeNull();
    expect(container.querySelector("tfoot")).toBeNull();
    expect(screen.queryByText("Total")).toBeNull();
  });

  it("report des largeurs de colonnes sur le pied : en parts, quelle que soit l'échelle du canvas", () => {
    // Tableau de 600 px de page affiché à 66 % : cellules de 132, 198 et 66 px à l'écran.
    const zoomed = columnFit([132, 198, 66], 396, 600, 0);
    expect(zoomed).toEqual({ columns: [33.333, 50, 16.667], width: 600, gutter: 0 });
    // Les mêmes colonnes à 100 % donnent les mêmes parts ; la barre de défilement décale le pied d'autant.
    expect(columnFit([200, 300, 100], 600, 600, 15)).toEqual({ columns: [33.333, 50, 16.667], width: 600, gutter: 15 });
    // Rien à reporter tant que le tableau n'est pas mesuré.
    expect(columnFit([0, 0], 0, 0, 0)).toBeNull();
    expect(columnFit([], 600, 600, 0)).toBeNull();
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
    const { container } = render(<MatrixVisual {...props(v, result(data))} />);
    const { shown } = expectPinnedTotal(container);
    // Intitulé, deux mois, colonne Total : une cellule par colonne, sans fusion.
    expect(shown).toHaveLength(4);
    expect(shown[0]?.textContent).toBe("Total");
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

  it("quand la place manque, un onglet ne descend ni sous son nom ni sous une part égale", () => {
    const v = visual("navigator", {}, { orientation: "horizontal", look: "tabs" }, "");
    render(<NavigatorVisual {...props(v, null)} />);
    const tabs = screen.getAllByRole("button");
    for (const tab of tabs) {
      // La borne remplace `min-w-0` (qui laissait rétrécir tous les onglets à la fois).
      expect(tab.className).toMatch(/min-w-\[var\(--tab-min\)\]/);
      expect(tab.className).not.toMatch(/\bmin-w-0\b/);
      expect(tab.style.getPropertyValue("--tab-min")).toBe(navigatorTabMinCss(tab.textContent ?? "", 4));
    }
    expect(navigatorTabMinCss("Dépenses", 4)).toBe(`min(${navigatorTabWidth("Dépenses")}px, calc((100% - 12px) / 4))`);
    // Vertical : un onglet par ligne, sans borne de largeur.
    const vertical = visual("navigator", {}, { orientation: "vertical", look: "tabs" }, "");
    const { container } = render(<NavigatorVisual {...props(vertical, null)} />);
    for (const tab of container.querySelectorAll("button")) expect(tab.style.getPropertyValue("--tab-min")).toBe("");
  });
});
