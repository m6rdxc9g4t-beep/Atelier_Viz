/** Formatage des valeurs dans les visuels (conventions françaises). */

import type { ColumnType, Scalar } from "../types/dataset";
import type { DateBin } from "../types/query";

export interface NumberFormat {
  decimals?: number;
  /** Notation compacte : 12 k, 3,4 M. */
  compact?: boolean;
  prefix?: string;
  suffix?: string;
}

const MONTHS = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

export function formatNumber(value: Scalar, fmt: NumberFormat = {}): string {
  if (value === null || value === "") return "(Vide)";
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(n)) return String(value);
  const auto = fmt.decimals ?? (Math.abs(n) >= 100 || Number.isInteger(n) ? 0 : 2);
  const text = new Intl.NumberFormat("fr-FR", {
    notation: fmt.compact ? "compact" : "standard",
    // Compact : 1 décimale (1,5 M) pour éviter des graduations identiques (« 2 M », « 2 M »).
    maximumFractionDigits: fmt.compact ? (fmt.decimals ?? 1) : auto,
    minimumFractionDigits: fmt.compact ? 0 : Math.min(auto, fmt.decimals ?? 0),
  }).format(n);
  return `${fmt.prefix ?? ""}${text}${fmt.suffix ?? ""}`;
}

function parseDate(value: Scalar): Date | null {
  if (typeof value !== "string") return null;
  const d = new Date(value.length === 10 ? `${value}T00:00:00` : value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Libellé d'une valeur de dimension (catégorie, date regroupée, booléen…). */
export function formatDimension(value: Scalar, type: ColumnType | undefined, bin?: DateBin | null): string {
  if (value === null || value === "") return "(Vide)";
  if (type === "boolean") return value === true || value === "True" ? "Oui" : "Non";
  if (type === "number") return formatNumber(value);
  if (type === "date") {
    const d = parseDate(value);
    if (!d) return String(value);
    switch (bin) {
      case "year":
        return String(d.getFullYear());
      case "quarter":
        return `T${Math.floor(d.getMonth() / 3) + 1} ${d.getFullYear()}`;
      case "month":
        return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
      case "week":
        return `sem. ${d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" })}`;
      default:
        return d.toLocaleDateString("fr-FR");
    }
  }
  return String(value);
}
