import { describe, expect, it } from "vitest";

import type { WorkbookSheet } from "../types/dataset";
import { defaultSelection, importEach, importLabel, importable, isWorkbook, needsSheetChoice, sheetChoices, sheetSummary, skippedMessage, toggleSheet } from "./workbook";

const sheet = (name: string, rows: number, columns: string[], error: string | null = null): WorkbookSheet => ({ name, dataset_name: `Budget 2026 — ${name}`, rows, columns, error });

const sheets = [sheet("Ventes", 3, ["Mois", "Région", "Montant"]), sheet("Notes", 0, [], "Feuille vide : aucune donnée à importer."), sheet("Objectifs été", 1, ["Région"])];

describe("classeur à plusieurs feuilles", () => {
  it("seul un classeur Excel a des feuilles", () => {
    expect(isWorkbook("Budget 2026.xlsx")).toBe(true);
    expect(isWorkbook("BUDGET.XLSX ")).toBe(true);
    expect(isWorkbook("ventes.csv")).toBe(false);
    expect(isWorkbook("export.xlsx.csv")).toBe(false);
    expect(isWorkbook("données.json")).toBe(false);
  });

  it("toutes les feuilles importables sont cochées au départ, la feuille vide ne l'est pas", () => {
    expect(importable(sheets).map((s) => s.name)).toEqual(["Ventes", "Objectifs été"]);
    expect(defaultSelection(sheets)).toEqual(["Ventes", "Objectifs été"]);
    expect(defaultSelection([])).toEqual([]);
  });

  it("le choix n'est proposé qu'à partir de deux feuilles : un classeur à une feuille s'importe comme avant", () => {
    expect(needsSheetChoice(sheets)).toBe(true);
    expect(needsSheetChoice([sheets[0]!])).toBe(false);
    expect(needsSheetChoice([])).toBe(false);
    // Deux feuilles dont une vide : le choix est montré, pour dire que la seconde est laissée.
    expect(needsSheetChoice(sheets.slice(0, 2))).toBe(true);
  });

  it("décocher puis recocher garde l'ordre du classeur ; une feuille vide ne se coche pas", () => {
    const without = toggleSheet(sheets, defaultSelection(sheets), "Ventes");
    expect(without).toEqual(["Objectifs été"]);
    expect(toggleSheet(sheets, without, "Ventes")).toEqual(["Ventes", "Objectifs été"]);
    expect(toggleSheet(sheets, without, "Notes")).toEqual(["Objectifs été"]);
    expect(toggleSheet(sheets, without, "Objectifs été")).toEqual([]);
  });

  it("résume une feuille : lignes et colonnes accordées, ou la raison", () => {
    expect(sheetSummary(sheets[0]!)).toBe("3 lignes · 3 colonnes");
    expect(sheetSummary(sheets[2]!)).toBe("1 ligne · 1 colonne");
    expect(sheetSummary(sheets[1]!)).toBe("Feuille vide : aucune donnée à importer.");
  });

  it("le bouton dit combien de feuilles partent", () => {
    expect(importLabel(0)).toBe("Aucune feuille cochée");
    expect(importLabel(1)).toBe("Importer 1 feuille");
    expect(importLabel(3)).toBe("Importer 3 feuilles");
  });

  it("après l'import, les feuilles laissées sont nommées avec leur raison", () => {
    expect(skippedMessage(2, [])).toBeNull();
    expect(skippedMessage(2, [{ name: "Notes", reason: "Feuille vide : aucune donnée à importer." }])).toBe(
      "2 feuilles importées. Laissée : « Notes » (Feuille vide : aucune donnée à importer).",
    );
    expect(skippedMessage(1, [{ name: "A", reason: "Feuille vide." }, { name: "B", reason: "Feuille illisible : x" }])).toBe(
      "1 feuille importée. Laissées : « A » (Feuille vide), « B » (Feuille illisible : x).",
    );
  });

  it("prépare les feuilles pour le dialogue : résumé et premières colonnes, raison pour une feuille vide", () => {
    const wide = sheet("Large", 1200, ["a", "b", "c", "d", "e", "f"]);
    expect(sheetChoices([...sheets, wide])).toEqual([
      { name: "Ventes", dataset_name: "Budget 2026 — Ventes", error: null, summary: "3 lignes · 3 colonnes — Mois, Région, Montant" },
      { name: "Notes", dataset_name: "Budget 2026 — Notes", error: "Feuille vide : aucune donnée à importer.", summary: "" },
      { name: "Objectifs été", dataset_name: "Budget 2026 — Objectifs été", error: null, summary: "1 ligne · 1 colonne — Région" },
      { name: "Large", dataset_name: "Budget 2026 — Large", error: null, summary: "1\u202f200 lignes · 6 colonnes — a, b, c, d…" },
    ]);
  });

  it("connexion : les feuilles s'importent l'une après l'autre, un échec ne bloque pas les suivantes", async () => {
    const order: string[] = [];
    const result = await importEach(["Ventes", "Cassée", "Objectifs"], async (name) => {
      order.push(name);
      if (name === "Cassée") throw new Error("Aucune donnée exploitable dans le fichier.");
      return { id: name };
    });
    expect(order).toEqual(["Ventes", "Cassée", "Objectifs"]);
    expect(result.imported).toEqual([{ id: "Ventes" }, { id: "Objectifs" }]);
    expect(result.skipped).toEqual([{ name: "Cassée", reason: "Aucune donnée exploitable dans le fichier." }]);
    expect(await importEach([], async () => 1)).toEqual({ imported: [], skipped: [] });
  });
});
