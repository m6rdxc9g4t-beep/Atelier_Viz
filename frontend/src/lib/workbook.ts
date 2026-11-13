/**
 * Classeurs Excel à plusieurs feuilles (logique pure du choix des feuilles à importer) : quelles feuilles sont
 * cochées au départ, libellés, bilan d'un import. Un CSV n'a qu'une feuille : il s'importe tel quel.
 */

import type { SkippedSheet, WorkbookSheet } from "../types/dataset";
import { formatCount } from "./format";

/** Vrai pour un classeur Excel, seul format à plusieurs feuilles (miroir de `is_workbook` du backend). */
export function isWorkbook(filename: string): boolean {
  return /\.xlsx$/i.test(filename.trim());
}

/** Feuille proposée dans le dialogue de choix : classeur déposé (examiné par le serveur) ou feuille d'une connexion. */
export interface SheetChoice {
  name: string;
  /** Nom du jeu créé par l'import de cette feuille. */
  dataset_name: string;
  /** « 3 lignes · 2 colonnes — Mois, Région » ; vide quand la source ne l'annonce pas (connexion). */
  summary: string;
  /** Feuille vide ou illisible : montrée avec sa raison, sans case à cocher. */
  error: string | null;
}

type Listed = Pick<SheetChoice, "name" | "error">;

/** Feuilles qui peuvent être importées (ni vides ni illisibles). */
export function importable<T extends Listed>(sheets: readonly T[]): T[] {
  return sheets.filter((s) => !s.error);
}

/** Le choix des feuilles n'est proposé que s'il y a un choix : au moins deux feuilles dans le classeur. */
export function needsSheetChoice(sheets: readonly unknown[]): boolean {
  return sheets.length > 1;
}

/** Au départ, toutes les feuilles importables sont cochées. */
export function defaultSelection(sheets: readonly Listed[]): string[] {
  return importable(sheets).map((s) => s.name);
}

/** Coche ou décoche une feuille, en gardant l'ordre du classeur ; une feuille non importable ne se coche pas. */
export function toggleSheet(sheets: readonly Listed[], selected: readonly string[], name: string): string[] {
  const has = selected.includes(name);
  return importable(sheets)
    .map((s) => s.name)
    .filter((n) => (n === name ? !has : selected.includes(n)));
}

const plural = (n: number, one: string, many: string) => `${formatCount(n)} ${n > 1 ? many : one}`;

/** « 3 lignes · 2 colonnes », ou la raison pour laquelle la feuille est laissée. */
export function sheetSummary(sheet: WorkbookSheet): string {
  if (sheet.error) return sheet.error;
  return `${plural(sheet.rows, "ligne", "lignes")} · ${plural(sheet.columns.length, "colonne", "colonnes")}`;
}

/** Feuilles d'un classeur examiné par le serveur, prêtes pour le dialogue : résumé et premières colonnes. */
export function sheetChoices(sheets: readonly WorkbookSheet[]): SheetChoice[] {
  return sheets.map((s) => ({
    name: s.name,
    dataset_name: s.dataset_name,
    error: s.error,
    summary: s.error ? "" : `${sheetSummary(s)}${s.columns.length ? ` — ${s.columns.slice(0, 4).join(", ")}${s.columns.length > 4 ? "…" : ""}` : ""}`,
  }));
}

/**
 * Importe des feuilles l'une après l'autre (connexion vers un fichier : une lecture de la source par feuille).
 * Une feuille qui échoue — vide, illisible — est notée avec sa raison et ne bloque pas les suivantes.
 */
export async function importEach<T>(names: readonly string[], importOne: (name: string) => Promise<T>): Promise<{ imported: T[]; skipped: SkippedSheet[] }> {
  const imported: T[] = [];
  const skipped: SkippedSheet[] = [];
  for (const name of names) {
    try {
      imported.push(await importOne(name));
    } catch (e) {
      skipped.push({ name, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { imported, skipped };
}

/** Libellé du bouton d'import selon le nombre de feuilles cochées. */
export function importLabel(count: number): string {
  return count === 0 ? "Aucune feuille cochée" : `Importer ${plural(count, "feuille", "feuilles")}`;
}

/**
 * Message après l'import quand des feuilles ont été laissées : `null` si tout a été importé.
 * « 2 feuilles importées. Laissée : « Notes » (Feuille vide : aucune donnée à importer.) »
 */
export function skippedMessage(imported: number, skipped: readonly SkippedSheet[]): string | null {
  if (!skipped.length) return null;
  const list = skipped.map((s) => `« ${s.name} » (${s.reason.replace(/\.$/, "")})`).join(", ");
  const done = imported > 1 ? `${imported} feuilles importées` : imported === 1 ? "1 feuille importée" : "Aucune feuille importée";
  return `${done}. ${skipped.length > 1 ? "Laissées" : "Laissée"} : ${list}.`;
}
