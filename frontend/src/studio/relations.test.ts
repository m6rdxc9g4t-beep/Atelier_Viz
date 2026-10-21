import { describe, expect, it } from "vitest";

import { dependentsOf } from "../hooks/useDatasetProfiles";
import type { ColumnProfile, DatasetProfile, RelationCheck } from "../types/dataset";
import { checkMessages, relationName, relationSummary, suggestRelation } from "./relations";

const col = (name: string, distinct: number, extra: Partial<ColumnProfile> = {}): ColumnProfile =>
  ({ name, type: "string", nulls: 0, distinct, top_values: [], ...extra }) as ColumnProfile;

const ds = (id: string, name: string, rows: number, columns: ColumnProfile[], relations: DatasetProfile["model"] = undefined): DatasetProfile =>
  ({ id, name, format: "csv", rows, columns_count: columns.length, created_at: "", columns, sample: [], model: relations }) as DatasetProfile;

const ventes = ds("v", "ventes_2026.csv", 500, [col("date", 300), col("region", 13), col("magasin", 40), col("ca", 480, { type: "number" })]);
const regions = ds("r", "Régions FR.xlsx", 13, [col("code", 13), col("region", 13), col("responsable", 9)]);

describe("relations", () => {
  it("nomme une relation d'après le jeu lié, sans doublon", () => {
    expect(relationName("regions.csv")).toBe("regions");
    expect(relationName("Régions FR.xlsx")).toBe("regions_fr");
    expect(relationName("regions.csv", ["regions"])).toBe("regions_2");
    expect(relationName("***")).toBe("lien");
  });

  it("propose les colonnes de même nom, de préférence uniques côté lié", () => {
    const s = suggestRelation(ventes, regions);
    expect(s).toMatchObject({ dataset_id: "r", from_column: "region", to_column: "region", name: "regions_fr", columns: null });
    // Aucune colonne commune : clé unique du jeu lié, première colonne de ce jeu.
    const other = ds("p", "produits.csv", 3, [col("sku", 3), col("famille", 2)]);
    expect(suggestRelation(ventes, other)).toMatchObject({ from_column: "date", to_column: "sku" });
    // Les colonnes calculées ou déjà liées ne servent pas de clé.
    const withCalc = ds("v2", "v.csv", 5, [col("region", 3, { calculated: true }), col("x", 5)]);
    expect(suggestRelation(withCalc, regions).from_column).toBe("x");
  });

  it("résume et explique le diagnostic", () => {
    expect(relationSummary(suggestRelation(ventes, regions), [regions])).toBe("region → Régions FR.xlsx · region");
    expect(relationSummary({ name: "x", dataset_id: "zz", from_column: "a", to_column: "b" }, [])).toContain("jeu supprimé");
    const base: RelationCheck = { ok: true, rows: 1000, matched: 1000, duplicates: 0, unmatched_sample: [] };
    const flat = (ms: { tone: string; text: string }[]) => ms.map((m) => ({ ...m, text: m.text.replace(/\s/g, " ") }));
    expect(flat(checkMessages(base, "regions"))).toEqual([{ tone: "ok", text: "Toutes les lignes (1 000) trouvent leur correspondance." }]);
    const partial = flat(checkMessages({ ...base, matched: 990, duplicates: 2, unmatched_sample: ["Corse"] }, "regions"));
    expect(partial.map((m) => m.tone)).toEqual(["warn", "warn"]);
    expect(partial[0]?.text).toContain("10 lignes sur 1 000 sans correspondance (ex. Corse)");
    expect(partial[1]?.text).toContain("2 clés en double dans « regions »");
    expect(checkMessages({ ...base, matched: 0 }, "r")[0]?.tone).toBe("error");
    expect(checkMessages({ ...base, ok: false, error: "Colonne inconnue" }, "r")).toEqual([{ tone: "error", text: "Colonne inconnue" }]);
  });

  it("trouve les jeux qui dépendent d'un autre, en chaîne", () => {
    const rel = (to: string) => ({ columns: [], measures: [], relations: [{ name: "l", dataset_id: to, from_column: "a", to_column: "b" }] });
    const a = ds("a", "a", 1, [], rel("b"));
    const b = ds("b", "b", 1, [], rel("c"));
    const c = ds("c", "c", 1, []);
    const d = ds("d", "d", 1, []);
    expect(dependentsOf("c", [a, b, c, d]).sort()).toEqual(["a", "b"]);
    expect(dependentsOf("a", [a, b, c, d])).toEqual([]);
  });
});
