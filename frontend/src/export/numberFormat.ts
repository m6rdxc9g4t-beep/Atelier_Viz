/**
 * Formats de nombres des graphiques PowerPoint (codes de format Excel).
 *
 * Les séparateurs (espace des milliers, virgule décimale) suivent la langue de PowerPoint :
 * un code « #,##0.0 » s'affiche « 12 345,6 » sur un poste en français.
 */

import type { NumberFormat } from "../visuals/format";

/** Texte littéral dans un code de format (entre guillemets, sans guillemets internes). */
const literal = (text: string | undefined): string => (text ? `"${text.replace(/"/g, "")}"` : "");

const decimalsPart = (n: number): string => (n > 0 ? `.${"0".repeat(Math.min(6, n))}` : "");

const UNITS = [
  { size: 1e9, scale: ",,,", unit: "\u00a0Md" },
  { size: 1e6, scale: ",,", unit: "\u00a0M" },
  { size: 1e3, scale: ",", unit: "\u00a0k" },
] as const;

/**
 * Code de format pour une série de valeurs.
 *
 * - décimales : celles du visuel, sinon comme `formatNumber` (0 si les valeurs sont entières ou ≥ 100, 2 sinon) ;
 * - compact, axe (`target = "axis"`) : une seule unité pour toutes les graduations, choisie avec une marge
 *   (l'axe dépasse la plus grande valeur) : 974 k donne des graduations « 0,2 M … 1,2 M » ;
 * - compact, étiquettes : unité propre à chaque valeur (« 974 k », « 1,9 M ») quand toutes sont positives,
 *   sinon unité commune (les sections conditionnelles d'Excel ne gèrent pas bien les négatifs) ;
 * - `percent` : graphiques empilés à 100 %.
 */
export function excelFormat(fmt: NumberFormat, values: number[], percent = false, target: "axis" | "label" = "axis"): string {
  if (percent) return "0%";
  const finite = values.filter(Number.isFinite);
  const maxAbs = finite.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const prefix = literal(fmt.prefix);
  const suffix = literal(fmt.suffix);
  const plain = (decimals: number) => `${prefix}#,##0${decimalsPart(decimals)}${suffix}`;
  const scaled = (u: (typeof UNITS)[number], decimals: number) => `${prefix}#,##0${decimalsPart(decimals)}${u.scale}"${u.unit}"${suffix}`;

  if (fmt.compact && target === "label" && maxAbs >= 1000 && maxAbs < 1e9 && finite.every((v) => v >= 0)) {
    // Comme Intl « compact » : 1 décimale en millions, aucune en milliers (2 conditions au plus dans un format).
    return `[>=1000000]${scaled(UNITS[1], fmt.decimals ?? 1)};[>=1000]${scaled(UNITS[2], fmt.decimals ?? 0)};${plain(fmt.decimals ?? 0)}`;
  }
  const reach = target === "axis" ? maxAbs * 1.2 : maxAbs;
  if (fmt.compact && reach >= 1000) {
    const u = UNITS.find((x) => reach >= x.size) ?? UNITS[2];
    // 1 décimale tant que l'axe reste sous 10 unités (0,2 M … 1,2 M), aucune au-delà (10 M, 20 M…).
    return scaled(u, fmt.decimals ?? (reach / u.size < 10 ? 1 : 0));
  }
  const decimals = fmt.decimals ?? (finite.every((v) => Number.isInteger(v) || Math.abs(v) >= 100) ? 0 : 2);
  return plain(decimals);
}
