import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import type { Visual } from "../types/report";
import type { QueryResult } from "../visuals/useQueryResult";
import { columnRef, csvCell, dataFile, excelSerial, sheetName, toCsv, visualDataSet, xlsxParts } from "./dataExport";

const visual = (roles: Visual["roles"], options: Visual["options"] = {}, title: string | null = null): Visual => ({
  id: "v1",
  type: "table",
  title,
  layout: { x: 0, y: 0, w: 400, h: 300 },
  dataset_id: "abcdefabcdef",
  roles,
  options,
  filters: [],
});

const result: QueryResult = {
  columns: [
    { key: "region", field: "region", role: "dimension", type: "string" },
    { key: "date|month", field: "date", role: "dimension", type: "date" },
    { key: "jour", field: "jour", role: "dimension", type: "date" },
    { key: "sum(ca)", field: "ca", role: "measure", type: "number" },
    { key: "__grouping", field: null, role: "grouping", type: "number" },
  ],
  rows: [
    { region: "Occitanie", "date|month": "2026-03-01", jour: "2026-03-14", "sum(ca)": 1234.5, __grouping: 0 },
    { region: "=SOMME(A1)", "date|month": "2026-04-01", jour: null, "sum(ca)": 2000, __grouping: 0 },
    // Sous-total : jamais exporté.
    { region: null, "date|month": null, jour: null, "sum(ca)": 3234.5, __grouping: 1 },
  ],
  truncated: false,
};

const roles: Visual["roles"] = {
  rows: [{ field: "region" }, { field: "date", bin: "month" }, { field: "jour" }],
  values: [{ field: "ca", agg: "sum" }],
};

describe("export des données d'un visuel", () => {
  it("reprend les lignes affichées, sans sous-totaux, avec des nombres bruts et de vraies dates", () => {
    const data = visualDataSet(visual(roles, { compact: true, suffix: " €" }, "Ventes par région"), result);
    expect(data).not.toBeNull();
    if (!data) return;
    expect(data.title).toBe("Ventes par région");
    expect(data.columns.map((c) => c.numeric)).toEqual([false, false, false, true]);
    expect(data.rows).toHaveLength(2);
    const [first] = data.rows;
    expect(first?.[1]).toEqual({ kind: "text", value: "mars 2026" });
    expect(first?.[2]).toMatchObject({ kind: "date" });
    expect(first?.[3]).toEqual({ kind: "number", value: 1234.5 });
    expect(data.rows[1]?.[2]).toBeNull();
    // Jamais compact à l'export : la valeur exacte, avec le suffixe du visuel.
    expect(data.columns[3]?.format).toBe('#,##0" €"');
  });

  it("n'exporte rien pour un résultat vide", () => {
    expect(visualDataSet(visual(roles), null)).toBeNull();
    expect(visualDataSet(visual(roles), { ...result, rows: [] })).toBeNull();
  });

  it("écrit un CSV pour Excel en français et neutralise les formules", () => {
    const data = visualDataSet(visual(roles), result);
    if (!data) throw new Error("données attendues");
    const csv = toCsv(data);
    const lines = csv.split("\r\n");
    expect(lines[1]).toBe("Occitanie;mars 2026;14/03/2026;1234,5");
    expect(lines[2]).toBe("'=SOMME(A1);avr. 2026;;2000");
    expect(csvCell({ kind: "text", value: 'a;"b"' })).toBe('"a;""b"""');
    expect(csvCell({ kind: "number", value: 0.1 + 0.2 })).toBe("0,3");
  });

  it("produit un classeur Excel valide (onglet, en-tête figé, formats)", async () => {
    const data = visualDataSet(visual(roles, { decimals: 1 }, "CA : Top [régions]"), result);
    if (!data) throw new Error("données attendues");
    const parts = xlsxParts(data);
    expect(parts["xl/workbook.xml"]).toContain('name="CA Top régions"');
    const sheet = parts["xl/worksheets/sheet1.xml"] ?? "";
    expect(sheet).toContain('<autoFilter ref="A1:D3"/>');
    expect(sheet).toContain(`<c r="C2" s="2"><v>${excelSerial(new Date(2026, 2, 14))}</v></c>`);
    expect(sheet).toContain('<c r="D2" s="3"><v>1234.5</v></c>');
    expect(sheet).toContain("=SOMME(A1)"); // texte en ligne : jamais une formule
    expect(sheet).not.toContain("<f>");
    expect(parts["xl/styles.xml"]).toContain('formatCode="#,##0.0"');

    const { blob, name } = await dataFile(data, "xlsx");
    expect(name).toBe("CA Top [régions].xlsx");
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(Object.keys(zip.files)).toEqual(expect.arrayContaining(["[Content_Types].xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/styles.xml"]));
  });

  it("calcule les références et numéros de série Excel", () => {
    expect([0, 25, 26, 701, 702].map(columnRef)).toEqual(["A", "Z", "AA", "ZZ", "AAA"]);
    expect(excelSerial(new Date(2026, 0, 1))).toBe(46023);
    expect(sheetName("   ")).toBe("Données");
    expect(sheetName("x".repeat(40))).toHaveLength(31);
  });

  it("ajoute le BOM au CSV", async () => {
    const data = visualDataSet(visual(roles), result);
    if (!data) throw new Error("données attendues");
    const { blob, name } = await dataFile(data, "csv");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(name).toMatch(/\.csv$/);
  });
});
