/** Export PDF, image PNG et rapport HTML autonome : tout se passe dans le navigateur. */

import { getProfile } from "../hooks/useDatasetProfiles";
import type { Extraction } from "../studio/extraction";
import { migratePage } from "../studio/grid";
import type { DatasetProfile } from "../types/dataset";
import type { Page, Report } from "../types/report";
import type { Selection } from "../visuals/types";
import { resolveReportTheme } from "./colors";
import { loadVisual, mapLimit } from "./data";
import { type DocumentFormat, type HtmlPage, PX_TO_PT, htmlReport, visualTable } from "./document";
import { activeFilterTexts, fileNameFor, formatDate } from "./notes";
import { capturePage, dataUrlBytes } from "./pageImage";

export interface DocumentInput {
  report: Report;
  pageId: string;
  selection: Selection | null;
  extraction?: Extraction | null;
  profiles: Map<string, DatasetProfile>;
  appMode: "light" | "dark";
  format: DocumentFormat;
  /** Toutes les pages ou la page affichée (l'image PNG est toujours la page affichée). */
  pages: "all" | "current";
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export interface DocumentResult {
  blob: Blob;
  fileName: string;
  pages: number;
}

/** Pages exportées : la page affichée, ou toutes sauf les pages d'extraction (atteintes par clic droit). */
export function documentPages(report: Report, pageId: string, pages: "all" | "current", format: DocumentFormat): Page[] {
  if (pages === "current" || format === "png") return report.pages.filter((p) => p.id === pageId);
  const ordinary = report.pages.filter((p) => !p.drillthrough);
  return ordinary.length ? ordinary : report.pages;
}

export async function exportDocument(input: DocumentInput): Promise<DocumentResult> {
  const { report, signal } = input;
  const pages = documentPages(report, input.pageId, input.pages, input.format).map(migratePage);
  const profiles = new Map(input.profiles);
  const ids = [...new Set(pages.flatMap((p) => p.visuals.map((v) => v.dataset_id)).filter((id): id is string => !!id && !profiles.has(id)))];
  for (const r of await Promise.allSettled(ids.map(getProfile))) if (r.status === "fulfilled") profiles.set(r.value.id, r.value);
  const theme = resolveReportTheme(report.theme, input.appMode);
  const selectionFor = (page: Page) => (input.selection && page.visuals.some((v) => v.id === input.selection?.visualId) ? input.selection : null);
  const extraction = input.extraction ?? null;
  const total = pages.length;
  input.onProgress?.(0, total);

  const images = [];
  for (const [i, page] of pages.entries()) {
    if (signal?.aborted) throw new DOMException("Export annulé.", "AbortError");
    images.push(await capturePage({ page, report, profiles, theme, selection: selectionFor(page), extraction }));
    input.onProgress?.(i + 1, total);
  }
  const current = report.pages.find((p) => p.id === input.pageId);
  const base = input.format === "png" && current ? `${report.name} - ${current.name}` : report.name;

  if (input.format === "png") {
    const image = images[0];
    if (!image) throw new Error("Aucune page à exporter.");
    return { blob: new Blob([dataUrlBytes(image.dataUrl)], { type: "image/png" }), fileName: fileNameFor(base, "png"), pages: 1 };
  }

  if (input.format === "pdf") {
    const { PDFDocument } = await import("pdf-lib");
    const doc = await PDFDocument.create();
    doc.setTitle(report.name);
    doc.setCreator("Atelier Viz");
    doc.setProducer("Atelier Viz");
    doc.setSubject(`Exporté le ${formatDate(new Date())}`);
    for (const image of images) {
      const png = await doc.embedPng(dataUrlBytes(image.dataUrl));
      const w = image.width * PX_TO_PT;
      const h = image.height * PX_TO_PT;
      doc.addPage([w, h]).drawImage(png, { x: 0, y: 0, width: w, height: h });
    }
    const bytes = await doc.save();
    return { blob: new Blob([bytes as BlobPart], { type: "application/pdf" }), fileName: fileNameFor(base, "pdf"), pages: images.length };
  }

  // Rapport HTML : images + filtres + données de chaque visuel (mêmes requêtes qu'à l'écran, en cache).
  const htmlPages: HtmlPage[] = [];
  for (const [i, page] of pages.entries()) {
    const image = images[i];
    if (!image) continue;
    const loaded = await mapLimit(page.visuals, 4, (v) => loadVisual(page, v, selectionFor(page), profiles));
    const active = activeFilterTexts(page, selectionFor(page), profiles);
    const extra = extraction?.pageId === page.id ? extraction.filters.map((f) => `Extraction : ${f.field} = ${f.values.join(", ")}`) : [];
    htmlPages.push({
      id: `page-${i + 1}`,
      name: page.name,
      image: image.dataUrl,
      width: image.width,
      height: image.height,
      filters: [...active.page, ...active.slicers, ...active.selection.map((s) => `Sélection : ${s}`), ...extra],
      tables: page.visuals
        .map((v, j) => (v.type === "slicer" || v.type === "button" || v.type === "text" ? null : visualTable(v, loaded[j]?.result ?? null)))
        .filter((t) => t !== null),
    });
  }
  const html = htmlReport(report, htmlPages, new Date());
  return { blob: new Blob([html], { type: "text/html;charset=utf-8" }), fileName: fileNameFor(base, "html"), pages: htmlPages.length };
}
