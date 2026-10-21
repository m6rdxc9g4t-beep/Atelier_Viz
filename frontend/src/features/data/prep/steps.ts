/** Étapes de préparation : libellés, descriptions lisibles, valeurs par défaut (logique pure, testée). */

import type { ColumnProfile, ColumnType, PrepKind, PrepOp, PrepStep, Scalar, TextMode } from "../../../types/dataset";

export const STEP_LABELS: Record<PrepKind, string> = {
  rename: "Renommer",
  remove: "Supprimer des colonnes",
  cast: "Changer le type",
  filter: "Filtrer les lignes",
  replace: "Remplacer des valeurs",
  fill: "Remplir les vides",
  text: "Nettoyer le texte",
  dedupe: "Supprimer les doublons",
  unpivot: "Dépivoter",
  split: "Fractionner",
};

export const TYPE_LABELS: Record<ColumnType, string> = { number: "nombre", string: "texte", date: "date", boolean: "booléen" };

export const OP_LABELS: Record<PrepOp, string> = {
  eq: "est égal à",
  neq: "est différent de",
  in: "fait partie de",
  not_in: "ne fait pas partie de",
  gt: "est supérieur à",
  gte: "est supérieur ou égal à",
  lt: "est inférieur à",
  lte: "est inférieur ou égal à",
  contains: "contient",
  not_contains: "ne contient pas",
  is_null: "est vide",
  not_null: "n'est pas vide",
};

export const TEXT_LABELS: Record<TextMode, string> = {
  trim: "Supprimer les espaces en trop",
  upper: "MAJUSCULES",
  lower: "minuscules",
  capitalize: "Première Lettre En Majuscule",
};

/** Opérateurs proposés selon le type de la colonne. */
export function opsFor(type: ColumnType): PrepOp[] {
  const common: PrepOp[] = ["eq", "neq", "in", "not_in", "is_null", "not_null"];
  if (type === "number" || type === "date") return [...common.slice(0, 2), "gt", "gte", "lt", "lte", ...common.slice(2)];
  if (type === "string") return [...common.slice(0, 2), "contains", "not_contains", ...common.slice(2)];
  return common;
}

/** L'opérateur attend-il des valeurs ? Plusieurs ? */
export function opArity(op: PrepOp): 0 | 1 | "many" {
  if (op === "is_null" || op === "not_null") return 0;
  return op === "in" || op === "not_in" ? "many" : 1;
}

const q = (v: Scalar) => (v === null ? "(vide)" : `« ${String(v)} »`);
const list = (names: string[]) => names.map((n) => `« ${n} »`).join(", ");

/** Une ligne lisible : « Montant → nombre », « Statut est égal à « ok » ». */
export function describeStep(step: PrepStep): string {
  switch (step.kind) {
    case "rename":
      return `« ${step.column} » → « ${step.to} »`;
    case "remove":
      return list(step.columns);
    case "cast":
      return `« ${step.column} » → ${TYPE_LABELS[step.to]}`;
    case "filter": {
      const arity = opArity(step.op);
      const values = arity === 0 ? "" : ` ${arity === "many" ? step.values.map(q).join(", ") : q(step.values[0] ?? null)}`;
      return `« ${step.column} » ${OP_LABELS[step.op]}${values}`;
    }
    case "replace":
      return `« ${step.column} » : ${q(step.find)} → ${q(step.replace)}${step.whole ? "" : " (dans le texte)"}`;
    case "fill":
      return `« ${step.column} » : ${step.down ? "valeur précédente" : q(step.value)}`;
    case "text":
      return `« ${step.column} » : ${TEXT_LABELS[step.mode].toLowerCase()}`;
    case "dedupe":
      return step.columns?.length ? `sur ${list(step.columns)}` : "lignes identiques";
    case "unpivot":
      return `${list(step.columns)} → « ${step.attribute} », « ${step.value} »`;
    case "split":
      return `« ${step.column} » par « ${step.separator} » → ${list(step.into)}`;
  }
}

/** Nom libre dérivé de `base` (« client_2 » si « client » existe). */
export function freeName(base: string, taken: string[]): string {
  const lower = new Set(taken.map((t) => t.toLowerCase()));
  if (!lower.has(base.toLowerCase())) return base;
  let n = 2;
  while (lower.has(`${base}_${n}`.toLowerCase())) n++;
  return `${base}_${n}`;
}

/** Étape proposée pour une action, préremplie avec la colonne sélectionnée. */
export function defaultStep(kind: PrepKind, column: ColumnProfile | undefined, columns: ColumnProfile[]): PrepStep {
  const name = column?.name ?? columns[0]?.name ?? "";
  const names = columns.map((c) => c.name);
  switch (kind) {
    case "rename":
      return { kind, column: name, to: name };
    case "remove":
      return { kind, columns: name ? [name] : [] };
    case "cast":
      return { kind, column: name, to: column?.type === "string" ? "number" : "string" };
    case "filter": {
      const top = column?.top_values[0]?.value;
      return column?.type === "string" && top !== undefined ? { kind, column: name, op: "eq", values: [top] } : { kind, column: name, op: "not_null", values: [] };
    }
    case "replace":
      return { kind, column: name, find: "", replace: "", whole: true };
    case "fill":
      return { kind, column: name, value: column?.type === "number" ? 0 : "", down: false };
    case "text":
      return { kind, column: name, mode: "trim" };
    case "dedupe":
      return { kind, columns: null };
    case "unpivot":
      return { kind, columns: name ? [name] : [], attribute: freeName("attribut", names), value: freeName("valeur", names) };
    case "split":
      return { kind, column: name, separator: " ", into: [freeName(`${name}_1`, names), freeName(`${name}_2`, names)] };
  }
}

/** Étape incomplète (valeur manquante, aucun nom…) : message à afficher, sinon null. */
export function stepProblem(step: PrepStep): string | null {
  const blank = (v: Scalar | undefined) => v === null || v === undefined || String(v).trim() === "";
  switch (step.kind) {
    case "rename":
      if (!step.to.trim()) return "Indiquez le nouveau nom.";
      return step.to.trim() === step.column ? "Le nouveau nom est identique." : null;
    case "remove":
    case "unpivot":
      return step.columns.length ? null : "Choisissez au moins une colonne.";
    case "filter":
      return opArity(step.op) !== 0 && (!step.values.length || step.values.every(blank)) ? "Indiquez une valeur." : null;
    case "replace":
      return !step.whole && blank(step.find) ? "Indiquez le texte à remplacer." : null;
    case "fill":
      return !step.down && blank(step.value) ? "Indiquez la valeur de remplacement." : null;
    case "split":
      if (!step.separator) return "Indiquez le séparateur.";
      return step.into.some((n) => !n.trim()) ? "Nommez les nouvelles colonnes." : null;
    default:
      return null;
  }
}

/** Valeur saisie dans un champ texte : nombre si la colonne est numérique et la saisie le permet. */
export function typedValue(text: string, type: ColumnType | undefined): Scalar {
  if (type === "number") {
    const n = Number(text.replace(/[\s  ]/g, "").replace(",", "."));
    if (text.trim() !== "" && Number.isFinite(n)) return n;
  }
  return text;
}
