/** Formatage des valeurs pour l'affichage (conventions françaises). */

import type { ColumnType, Scalar } from "../types/dataset";

const numberFmt = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 });
const dateFmt = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short" });

/** Rend une cellule selon le type de sa colonne ; `null` → tiret cadratin. */
export function formatValue(value: Scalar, type: ColumnType): string {
  if (value === null || value === "") return "—";
  switch (type) {
    case "number":
      return typeof value === "number" ? numberFmt.format(value) : String(value);
    case "date": {
      const date = new Date(String(value));
      return Number.isNaN(date.getTime()) ? String(value) : dateFmt.format(date);
    }
    case "boolean":
      return value === true || value === "True" ? "Oui" : "Non";
    default:
      return String(value);
  }
}

export function formatCount(n: number): string {
  return numberFmt.format(n);
}
