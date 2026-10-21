import { describe, expect, it } from "vitest";

import type { ColumnProfile, PrepStep } from "../../../types/dataset";
import { defaultStep, describeStep, freeName, opArity, opsFor, stepProblem, typedValue } from "./steps";

const col = (name: string, type: ColumnProfile["type"], top: string[] = []): ColumnProfile => ({
  name,
  type,
  nulls: 0,
  distinct: 3,
  min: null,
  max: null,
  mean: null,
  top_values: top.map((value) => ({ value, count: 1 })),
});
const COLS = [col("Client", "string", ["Dupont"]), col("Montant", "number"), col("Date", "date"), col("attribut", "string")];

describe("étapes de préparation", () => {
  it("propose des étapes préremplies avec la colonne sélectionnée", () => {
    expect(defaultStep("rename", COLS[0], COLS)).toEqual({ kind: "rename", column: "Client", to: "Client" });
    expect(defaultStep("cast", COLS[0], COLS)).toMatchObject({ to: "number" });
    expect(defaultStep("cast", COLS[1], COLS)).toMatchObject({ to: "string" });
    expect(defaultStep("filter", COLS[0], COLS)).toEqual({ kind: "filter", column: "Client", op: "eq", values: ["Dupont"] });
    expect(defaultStep("filter", COLS[1], COLS)).toMatchObject({ op: "not_null", values: [] });
    expect(defaultStep("unpivot", COLS[1], COLS)).toMatchObject({ columns: ["Montant"], attribute: "attribut_2", value: "valeur" });
    expect(defaultStep("split", COLS[0], COLS)).toMatchObject({ into: ["Client_1", "Client_2"] });
    expect(defaultStep("dedupe", undefined, COLS)).toEqual({ kind: "dedupe", columns: null });
  });

  it("décrit chaque étape en une ligne", () => {
    const cases: [PrepStep, string][] = [
      [{ kind: "rename", column: "a", to: "b" }, "« a » → « b »"],
      [{ kind: "cast", column: "Montant", to: "number" }, "« Montant » → nombre"],
      [{ kind: "filter", column: "Statut", op: "in", values: ["ok", "ko"] }, "« Statut » fait partie de « ok », « ko »"],
      [{ kind: "filter", column: "Statut", op: "is_null", values: [] }, "« Statut » est vide"],
      [{ kind: "replace", column: "x", find: null, replace: 0, whole: true }, "« x » : (vide) → « 0 »"],
      [{ kind: "fill", column: "x", value: null, down: true }, "« x » : valeur précédente"],
      [{ kind: "dedupe", columns: null }, "lignes identiques"],
      [{ kind: "split", column: "nom", separator: " ", into: ["a", "b"] }, "« nom » par «   » → « a », « b »"],
    ];
    for (const [step, text] of cases) expect(describeStep(step)).toBe(text);
  });

  it("signale les étapes incomplètes", () => {
    expect(stepProblem({ kind: "rename", column: "a", to: "a" })).toMatch(/identique/);
    expect(stepProblem({ kind: "remove", columns: [] })).toMatch(/au moins une/);
    expect(stepProblem({ kind: "filter", column: "a", op: "eq", values: [""] })).toMatch(/valeur/);
    expect(stepProblem({ kind: "filter", column: "a", op: "not_null", values: [] })).toBeNull();
    expect(stepProblem({ kind: "fill", column: "a", value: "", down: true })).toBeNull();
    expect(stepProblem({ kind: "split", column: "a", separator: ";", into: ["x", ""] })).toMatch(/Nommez/);
  });

  it("adapte opérateurs et saisies au type", () => {
    expect(opsFor("number")).toContain("gte");
    expect(opsFor("string")).toContain("contains");
    expect(opsFor("boolean")).not.toContain("gt");
    expect(opArity("in")).toBe("many");
    expect(opArity("not_null")).toBe(0);
    expect(typedValue("1 234,5", "number")).toBe(1234.5);
    expect(typedValue("abc", "number")).toBe("abc");
    expect(typedValue("12", "string")).toBe("12");
    expect(freeName("valeur", ["Valeur", "valeur_2"])).toBe("valeur_3");
  });
});
