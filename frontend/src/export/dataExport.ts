/**
 * Export des données d'un visuel (CSV ou Excel) — comme « Exporter les données » de Power BI.
 *
 * On exporte exactement ce que le visuel affiche : même requête, mêmes filtres (page, segments,
 * filtrage croisé, exploration), sans les lignes de sous-total. Tout se passe dans le navigateur.
 *
 * - Mesures : nombres bruts (pas de notation compacte) avec le format du visuel (décimales, préfixe,
 *   suffixe, %) — dans Excel, ce sont de vrais nombres, sommables.
 * - Dates non regroupées : vraies dates Excel ; dates regroupées (mois, trimestre…) : libellé affiché.
 * - CSV « Excel français » : séparateur « ; », virgule décimale, BOM UTF-8, fins de ligne CRLF ;
 *   un texte qui commence par = + - @ est préfixé d'une apostrophe (pas de formule injectée).
 */

import type { FieldBinding, Visual } from "../types/report";
import { numberFormat } from "../visuals/common";
import { bindingKey, bindingLabel } from "../visuals/fields";
import { formatDimension, parseDate } from "../visuals/format";
import { defaultTitle } from "../visuals/title";
import type { QueryResult } from "../visuals/useQueryResult";
import { fileNameFor } from "./notes";
import { excelFormat } from "./numberFormat";

export type DataFormat = "csv" | "xlsx";

export type DataCell =
  | { kind: "number"; value: number }
  | { kind: "date"; value: Date }
  | { kind: "text"; value: string }
  | null;

export interface DataColumn {
  label: string;
  numeric: boolean;
  /** Code de format Excel des nombres (mesures), ou null. */
  format: string | null;
}

export interface VisualDataSet {
  title: string;
  columns: DataColumn[];
  rows: DataCell[][];
  /** Le moteur a limité le résultat (Top N conseillé). */
  truncated: boolean;
}

/** Données affichées par un visuel, prêtes à exporter, ou null s'il n'en a pas. */
export function visualDataSet(visual: Visual, result: QueryResult | null): VisualDataSet | null {
  if (!result || !result.columns.length) return null;
  const bindings = Object.values(visual.roles).flat();
  const byKey = new Map<string, FieldBinding>(bindings.map((b) => [bindingKey(b), b]));
  const cols = result.columns.filter((c) => c.role !== "grouping" && !c.key.startsWith("__"));
  const rows = result.rows.filter((r) => !r.__grouping);
  if (!cols.length || !rows.length) return null;

  const columns: DataColumn[] = cols.map((c) => {
    const b = byKey.get(c.key);
    const label = b ? bindingLabel(b) : (c.field ?? c.key);
    if (c.role !== "measure") return { label, numeric: c.type === "number", format: null };
    // Format complet (jamais compact : on exporte la valeur exacte).
    const fmt = { ...numberFormat(visual, b), compact: false };
    const values = rows.map((r) => r[c.key]).filter((v): v is number => typeof v === "number");
    return { label, numeric: true, format: excelFormat(fmt, values, false, "label") };
  });

  return {
    title: visual.title || defaultTitle(visual),
    columns,
    truncated: result.truncated,
    rows: rows.map((r) =>
      cols.map((c): DataCell => {
        const v = r[c.key] ?? null;
        if (v === null || v === "") return null;
        if (c.role === "measure" || c.type === "number") {
          const n = typeof v === "number" ? v : Number(v);
          return Number.isFinite(n) ? { kind: "number", value: n } : { kind: "text", value: String(v) };
        }
        const b = byKey.get(c.key);
        if (c.type === "date" && !b?.bin) {
          const d = parseDate(v);
          if (d) return { kind: "date", value: d };
        }
        return { kind: "text", value: formatDimension(v, c.type, b?.bin ?? null) };
      }),
    ),
  };
}

// ---------------------------------------------------------------------------------------------- CSV

const pad = (n: number) => String(n).padStart(2, "0");
const frDate = (d: Date) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;

/** Nombre au format français, sans séparateur de milliers (relu tel quel par Excel FR). */
const frNumber = (n: number) => String(Number.parseFloat(n.toPrecision(15))).replace(".", ",");

/** Texte d'une cellule CSV : guillemets si nécessaire, formule neutralisée. */
export function csvCell(cell: DataCell): string {
  if (!cell) return "";
  let s = cell.kind === "number" ? frNumber(cell.value) : cell.kind === "date" ? frDate(cell.value) : cell.value;
  if (cell.kind === "text" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Contenu CSV (sans BOM) : en-tête puis une ligne par élément, séparateur « ; », CRLF. */
export function toCsv(data: VisualDataSet): string {
  const head = data.columns.map((c) => csvCell({ kind: "text", value: c.label })).join(";");
  return [head, ...data.rows.map((r) => r.map(csvCell).join(";"))].join("\r\n") + "\r\n";
}

// -------------------------------------------------------------------------------------------- Excel

const xml = (s: string) =>
  s
    // Caractères interdits en XML 1.0 (contrôles hors tabulation / retours).
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Référence de colonne Excel : 0 → A, 25 → Z, 26 → AA. */
export function columnRef(index: number): string {
  let s = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Numéro de série Excel d'une date (jours depuis le 30/12/1899, date locale). */
export function excelSerial(d: Date): number {
  return (Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) - Date.UTC(1899, 11, 30)) / 86_400_000;
}

/** Nom d'onglet valide (31 caractères, sans : \ / ? * [ ]). */
export function sheetName(title: string): string {
  const s = title.replace(/[:\\/?*[\]]/g, " ").replace(/\s+/g, " ").trim().replace(/^'+|'+$/g, "").slice(0, 31).trim();
  return s || "Données";
}

/**
 * Parties du classeur (chemin → XML). Styles : 0 = standard, 1 = en-tête gras, 2 = date,
 * 3 et suivants = un format de nombre par colonne qui en a un.
 */
export function xlsxParts(data: VisualDataSet): Record<string, string> {
  const formats: string[] = [];
  const styleOf = data.columns.map((c) => {
    if (!c.format) return 0;
    let i = formats.indexOf(c.format);
    if (i < 0) i = formats.push(c.format) - 1;
    return 3 + i;
  });
  const numFmts = [`<numFmt numFmtId="164" formatCode="dd/mm/yyyy"/>`, ...formats.map((f, i) => `<numFmt numFmtId="${165 + i}" formatCode="${xml(f)}"/>`)];
  const xfs = [
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>`,
    `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" applyFont="1"/>`,
    `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/>`,
    ...formats.map((_, i) => `<xf numFmtId="${165 + i}" fontId="0" fillId="0" borderId="0" applyNumberFormat="1"/>`),
  ];

  const cell = (c: DataCell, ref: string, col: number): string => {
    if (!c) return "";
    if (c.kind === "number") return `<c r="${ref}" s="${styleOf[col] ?? 0}"><v>${c.value}</v></c>`;
    if (c.kind === "date") return `<c r="${ref}" s="2"><v>${excelSerial(c.value)}</v></c>`;
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(c.value)}</t></is></c>`;
  };
  const header = `<row r="1">${data.columns
    .map((c, j) => `<c r="${columnRef(j)}1" t="inlineStr" s="1"><is><t xml:space="preserve">${xml(c.label)}</t></is></c>`)
    .join("")}</row>`;
  const body = data.rows.map((r, i) => `<row r="${i + 2}">${r.map((c, j) => cell(c, `${columnRef(j)}${i + 2}`, j)).join("")}</row>`).join("");
  // Largeur : d'après le texte le plus long de la colonne (bornée).
  const widths = data.columns.map((c, j) => {
    const longest = data.rows.slice(0, 500).reduce((m, r) => {
      const v = r[j];
      const len = !v ? 0 : v.kind === "text" ? v.value.length : v.kind === "date" ? 10 : String(Math.round(v.value)).length + 4;
      return Math.max(m, len);
    }, c.label.length);
    return Math.min(60, Math.max(8, longest + 2));
  });
  const cols = `<cols>${widths.map((w, j) => `<col min="${j + 1}" max="${j + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`;
  const last = `${columnRef(data.columns.length - 1)}${data.rows.length + 1}`;

  return {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheetName(data.title))}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="${numFmts.length}">${numFmts.join("")}</numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
    "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${last}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols}<sheetData>${header}${body}</sheetData><autoFilter ref="A1:${last}"/></worksheet>`,
  };
}

const MIME = {
  csv: "text/csv;charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
} as const;

/** Fichier prêt à enregistrer (JSZip chargé à la demande pour Excel). */
export async function dataFile(data: VisualDataSet, format: DataFormat): Promise<{ blob: Blob; name: string }> {
  const name = fileNameFor(data.title, format);
  if (format === "csv") return { blob: new Blob(["﻿", toCsv(data)], { type: MIME.csv }), name };
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  for (const [path, content] of Object.entries(xlsxParts(data))) zip.file(path, content);
  const blob = await zip.generateAsync({ type: "blob", mimeType: MIME.xlsx, compression: "DEFLATE" });
  return { blob, name };
}
