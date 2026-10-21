import { describe, expect, it } from "vitest";

import type { Page, Report, Visual } from "../types/report";
import { MAX_TABLE_ROWS, escapeHtml, htmlReport, visualTable } from "./document";
import { documentPages } from "./exportDocument";
import { pageExtent } from "./pageImage";

const bar: Visual = {
  id: "b",
  type: "bar",
  title: "CA par région",
  layout: { x: 0, y: 0, w: 400, h: 300 },
  dataset_id: "d",
  roles: { category: [{ field: "region" }], values: [{ field: "ca", agg: "sum" }, { field: "ca", agg: "sum", show: { kind: "yoy_pct", date: "date" } }] },
  options: {},
  filters: [],
};
const result = {
  columns: [
    { key: "region", field: "region", role: "dimension" as const, type: "string" as const },
    { key: "sum(ca)", field: "ca", role: "measure" as const, type: "number" as const },
    { key: "sum(ca)@yoy_pct", field: "ca", role: "measure" as const, type: "number" as const },
  ],
  rows: [
    { region: "Nord", "sum(ca)": 1234567.8, "sum(ca)@yoy_pct": 12.345 },
    { region: null, "sum(ca)": 10, "sum(ca)@yoy_pct": null },
  ],
  truncated: false,
};
const page = (id: string, extra: Partial<Page> = {}): Page => ({ id, name: `Page ${id}`, visuals: [], filters: [], size: { width: 1280, height: 720 }, ...extra });

describe("export PDF / image / HTML", () => {
  it("met les données d'un visuel en tableau, valeurs formatées comme à l'écran", () => {
    const t = visualTable(bar, result);
    expect(t?.title).toBe("CA par région");
    expect(t?.columns).toEqual(["region", "Somme de ca", "Évolution vs N-1 — Somme de ca"]);
    expect(t?.numeric).toEqual([false, true, true]);
    expect(t?.rows[0]?.[0]).toBe("Nord");
    expect(t?.rows[0]?.[2]?.replace(/\s/g, " ")).toBe("12,3 %");
    expect(visualTable(bar, { ...result, rows: [] })).toBeNull();
    const many = { ...result, rows: Array.from({ length: MAX_TABLE_ROWS + 5 }, (_, i) => ({ region: `R${i}`, "sum(ca)": i, "sum(ca)@yoy_pct": 0 })) };
    expect(visualTable(bar, many)?.more).toBe(5);
  });

  it("écrit un rapport HTML autonome, échappé et sans ressource externe", () => {
    const html = htmlReport(
      { name: "Ventes <2026>" },
      [{ id: "page-1", name: "Synthèse & co", image: "data:image/png;base64,AAAA", width: 1280, height: 720, filters: ['region : "Nord"'], tables: [visualTable(bar, result)!] }],
      new Date(2026, 9, 21),
    );
    expect(html).toContain("<title>Ventes &lt;2026&gt;</title>");
    expect(html).toContain("Synthèse &amp; co");
    expect(html).toContain("region : &quot;Nord&quot;");
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).toContain("21 octobre 2026");
    expect(html).not.toMatch(/(src|href)="(https?:)?\/\//);
    expect(html).not.toMatch(/<link\b/);
    expect(escapeHtml(`<a href='x'>&</a>`)).toBe("&lt;a href=&#39;x&#39;&gt;&amp;&lt;/a&gt;");
  });

  it("choisit les pages et mesure leur hauteur réelle", () => {
    const report = { pages: [page("a"), page("b", { drillthrough: { fields: ["region"] } }), page("c")] } as Report;
    expect(documentPages(report, "c", "all", "pdf").map((p) => p.id)).toEqual(["a", "c"]);
    expect(documentPages(report, "c", "all", "png").map((p) => p.id)).toEqual(["c"]);
    expect(documentPages(report, "b", "current", "html").map((p) => p.id)).toEqual(["b"]);
    expect(pageExtent(page("x", { visuals: [{ ...bar, layout: { x: 0, y: 600, w: 100, h: 400 } }] }))).toEqual({ width: 1280, height: 1016 });
    expect(pageExtent(page("y"))).toEqual({ width: 1280, height: 720 });
  });
});
