/**
 * Export d'un rapport en PowerPoint (.pptx), entièrement dans le navigateur : aucune donnée ne
 * quitte la machine. Une page = une diapositive (ou plusieurs si elle est très haute).
 *
 * Étapes : plan des diapositives → requêtes (filtres, segments, couleurs stables) → captures des
 * visuels sans équivalent natif → écriture pptxgenjs (chargé à la demande).
 */

import { getProfile } from "../hooks/useDatasetProfiles";
import type { DatasetProfile } from "../types/dataset";
import type { Page, Report, Visual } from "../types/report";
import { drillView } from "../visuals/drill";
import { VISUALS } from "../visuals/registry";
import type { Selection } from "../visuals/types";
import { type ExportMode, buildVisual, frameGeometry, needsImage } from "./buildVisual";
import { captureVisual } from "./capture";
import { exportTheme, pptColor, resolveReportTheme } from "./colors";
import { type LoadedVisual, loadVisual, mapLimit } from "./data";
import { migratePage } from "../studio/grid";
import { type Band, type FitMode, REF_WIDTH, SLIDE, SLIDE_MARGIN, TITLE_BAND, contentArea, placeBand, splitPage } from "./layout";
import { fileNameFor, formatDate, slideNotes } from "./notes";
import { api } from "../lib/api";
import { pageFacts } from "../summary/facts";
import { summaryNotes, summaryRequest } from "../summary/pageSummary";
import type { ProviderChoice } from "../types/ai";
import { addItems } from "./writer";

export interface ExportOptions {
  /** Toutes les pages ou la page affichée. */
  pages: "all" | "current";
  /** Graphiques PowerPoint modifiables, ou images fidèles à l'écran. */
  mode: ExportMode;
  titleSlide: boolean;
  /** Nom de la page en titre de chaque diapositive. */
  pageTitles: boolean;
  /** Pages hautes : réduire sur une diapositive, ou répartir sur plusieurs. */
  fit: FitMode;
  /** Synthèse IA (chiffres vérifiés) en tête des notes de chaque page. */
  aiNotes: boolean;
}

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = { pages: "all", mode: "native", titleSlide: true, pageTitles: true, fit: "split", aiNotes: false };

export interface ExportProgress {
  step: "data" | "images" | "summary" | "slides" | "file";
  done: number;
  total: number;
}

export interface ExportResult {
  blob: Blob;
  fileName: string;
  slides: number;
  nativeVisuals: number;
  imageVisuals: number;
  warnings: string[];
}

export interface ExportInput {
  report: Report;
  pageId: string;
  selection: Selection | null;
  profiles: Map<string, DatasetProfile>;
  appMode: "light" | "dark";
  options: ExportOptions;
  /** Moteur d'IA des synthèses (option `aiNotes`). */
  aiProvider?: ProviderChoice;
  onProgress?: (p: ExportProgress) => void;
  signal?: AbortSignal;
}

/** Police des diapositives (police du thème PowerPoint, modifiable en un clic dans PowerPoint). */
export const EXPORT_FONT = "Segoe UI";

interface PlannedSlide {
  page: Page;
  band: Band;
  part: number;
  parts: number;
}

/** Plan des diapositives : une ou plusieurs par page, numérotées. */
export function planSlides(pages: Page[], options: Pick<ExportOptions, "fit" | "pageTitles" | "titleSlide">) {
  const area = contentArea(options.pageTitles);
  const slides: PlannedSlide[] = [];
  const firstSlide = new Map<string, number>();
  for (const raw of pages) {
    // Anciens rapports (grille) : convertis en pixels comme dans le Studio.
    const page = migratePage(raw);
    const width = page.size?.width ?? REF_WIDTH;
    const bands = splitPage(page.visuals, area, options.fit, width);
    const list = bands.length ? bands : [{ visuals: [], top: 0, bottom: 0, width }];
    firstSlide.set(page.id, slides.length + 1 + (options.titleSlide ? 1 : 0));
    list.forEach((band, i) => slides.push({ page, band, part: i + 1, parts: list.length }));
  }
  return { area, slides, firstSlide };
}

function abortIfNeeded(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Export annulé.", "AbortError");
}

export async function exportReport(input: ExportInput): Promise<ExportResult> {
  const { report, options, signal, onProgress } = input;
  const pages = options.pages === "all" ? report.pages : report.pages.filter((p) => p.id === input.pageId);
  // Profils de tous les jeux utilisés (une page jamais affichée peut en utiliser un autre).
  const profiles = new Map(input.profiles);
  const ids = [...new Set(pages.flatMap((p) => p.visuals.map((v) => v.dataset_id)).filter((id): id is string => !!id && !profiles.has(id)))];
  for (const r of await Promise.allSettled(ids.map(getProfile))) if (r.status === "fulfilled") profiles.set(r.value.id, r.value);
  const reportTheme = resolveReportTheme(report.theme, input.appMode);
  const theme = exportTheme(reportTheme);
  const plan = planSlides(pages, options);
  const exportedAt = new Date();
  const warnings: string[] = [];
  const selectionFor = (page: Page) => (input.selection && page.visuals.some((v) => v.id === input.selection?.visualId) ? input.selection : null);

  // 1. Données (4 requêtes à la fois, cache partagé avec le Studio).
  const entries = pages.flatMap((page) => page.visuals.map((visual) => ({ page, visual })));
  let loaded = 0;
  onProgress?.({ step: "data", done: 0, total: entries.length });
  const data = new Map<string, LoadedVisual>();
  await mapLimit(entries, 4, async ({ page, visual }) => {
    abortIfNeeded(signal);
    data.set(visual.id, await loadVisual(page, visual, selectionFor(page), profiles));
    onProgress?.({ step: "data", done: ++loaded, total: entries.length });
  });

  // 2. Captures des visuels sans équivalent natif (une à la fois : rendu hors écran).
  const placements = new Map<string, { slide: PlannedSlide; rect: ReturnType<ReturnType<typeof placeBand>["rect"]>; scale: number }>();
  for (const slide of plan.slides) {
    const placement = placeBand(slide.band, plan.area);
    for (const v of slide.band.visuals) placements.set(v.id, { slide, rect: placement.rect(v.layout), scale: placement.scale });
  }
  const toCapture = entries.filter(({ visual }) => needsImage(visual, VISUALS[visual.type], options.mode) && !data.get(visual.id)?.error);
  const images = new Map<string, string | null>();
  onProgress?.({ step: "images", done: 0, total: toCapture.length });
  for (const [i, { page, visual }] of toCapture.entries()) {
    abortIfNeeded(signal);
    const placed = placements.get(visual.id);
    const loadedVisual = data.get(visual.id);
    if (!placed || !loadedVisual) continue;
    const body = frameGeometry(visual, placed.rect, placed.scale).body;
    images.set(
      visual.id,
      await captureVisual({
        visual: drillView(visual),
        def: VISUALS[visual.type],
        dataset: visual.dataset_id ? profiles.get(visual.dataset_id) : undefined,
        result: loadedVisual.result,
        filters: loadedVisual.filters,
        page,
        report,
        theme: reportTheme,
        width: body.w / placed.scale,
        height: body.h / placed.scale,
      }),
    );
    onProgress?.({ step: "images", done: i + 1, total: toCapture.length });
  }

  // 2 bis. Synthèses IA des pages (une page à la fois ; on s'arrête au premier échec).
  const summaries = new Map<string, string[]>();
  if (options.aiNotes) {
    const withFacts = pages.map((page) => ({ page, facts: pageFacts(page, (id) => data.get(id)) })).filter((p) => p.facts.length);
    onProgress?.({ step: "summary", done: 0, total: withFacts.length });
    for (const [i, { page, facts }] of withFacts.entries()) {
      abortIfNeeded(signal);
      try {
        const res = await api.summarizePage(summaryRequest(report.name, page, selectionFor(page), profiles, facts, input.aiProvider ?? "auto"), signal);
        summaries.set(page.id, summaryNotes(res));
      } catch (err) {
        if ((err as Error).name === "AbortError") throw err;
        warnings.push(`Synthèse IA interrompue (page « ${page.name} ») : ${err instanceof Error ? err.message : String(err)}`);
        break;
      }
      onProgress?.({ step: "summary", done: i + 1, total: withFacts.length });
    }
  }

  // 3. Diapositives.
  abortIfNeeded(signal);
  const { default: PptxGenJS } = await import("pptxgenjs");
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.theme = { headFontFace: EXPORT_FONT, bodyFontFace: EXPORT_FONT };
  pptx.title = report.name;
  pptx.subject = "Rapport exporté depuis Atelier Viz";
  pptx.author = "Atelier Viz";

  const page = pptColor(theme.page);
  const text = pptColor(theme.text);
  const muted = pptColor(theme.muted);
  const footer = { x: SLIDE_MARGIN, y: SLIDE.h - 0.28, w: 8, h: 0.22 };
  const slideNumber = { x: SLIDE.w - SLIDE_MARGIN - 1, y: SLIDE.h - 0.28, w: 1, h: 0.22, fontSize: 9, color: muted, align: "right" as const };
  const titlePlaceholder = {
    placeholder: {
      options: { name: "title", type: "title" as const, x: SLIDE_MARGIN, y: SLIDE_MARGIN, w: SLIDE.w - 2 * SLIDE_MARGIN, h: TITLE_BAND - 0.12, fontSize: 20, bold: true, color: text, align: "left" as const, valign: "middle" as const, margin: 0 },
      text: "",
    },
  };
  const footerText = { text: { text: report.name, options: { ...footer, fontSize: 9, color: muted, margin: 0 } } };
  pptx.defineSlideMaster({ title: "ATELIER_TITRE", background: { color: page }, objects: [] });
  pptx.defineSlideMaster({ title: "ATELIER_PAGE", background: { color: page }, objects: [titlePlaceholder, footerText], slideNumber });
  pptx.defineSlideMaster({ title: "ATELIER_PAGE_SEULE", background: { color: page }, objects: [{ text: { text: report.name, options: { ...footer, fontSize: 9, color: muted, margin: 0 } } }], slideNumber: { ...slideNumber } });

  const COVER = "Couverture";
  if (options.titleSlide) {
    pptx.addSection({ title: COVER });
    const s = pptx.addSlide({ masterName: "ATELIER_TITRE", sectionTitle: COVER });
    const datasets = [...new Set(pages.flatMap((p) => p.visuals.map((v) => v.dataset_id)).filter((id): id is string => !!id))]
      .map((id) => profiles.get(id)?.name)
      .filter(Boolean);
    s.addShape(pptx.ShapeType.rect, { x: 0.8, y: 2.55, w: 0.6, h: 0.08, fill: { color: pptColor(theme.accent) }, line: { type: "none" }, objectName: "Filet" });
    s.addText(report.name, { x: 0.8, y: 2.75, w: 11.7, h: 1.2, fontSize: 40, bold: true, color: text, margin: 0, valign: "top", isTextBox: true, fit: "shrink", objectName: "Titre du rapport" });
    const pageCount = `${pages.length} page${pages.length > 1 ? "s" : ""}`;
    s.addText(
      [
        { text: [pageCount, datasets.length ? `Source : ${datasets.join(", ")}` : ""].filter(Boolean).join(" · "), options: { breakLine: true } },
        { text: `Exporté le ${formatDate(exportedAt)}`, options: { fontSize: 13 } },
      ],
      { x: 0.8, y: 4.05, w: 11.7, h: 0.9, fontSize: 16, color: muted, margin: 0, valign: "top", isTextBox: true, paraSpaceAfter: 4, objectName: "Sous-titre" },
    );
    s.addNotes(`${report.name}\n${pageCount}. Exporté le ${formatDate(exportedAt)} depuis Atelier Viz.`);
  }

  let nativeVisuals = 0;
  let imageVisuals = 0;
  // Une section PowerPoint par page (titres uniques : pptxgenjs range les diapositives par titre de section).
  const sections = new Map<string, string>();
  for (const p of pages) {
    const base = p.name.trim() || "Page";
    let title = base;
    for (let k = 2; [...sections.values()].includes(title) || (options.titleSlide && title === COVER); k++) title = `${base} (${k})`;
    sections.set(p.id, title);
  }
  let currentSection = "";
  for (const [i, planned] of plan.slides.entries()) {
    abortIfNeeded(signal);
    onProgress?.({ step: "slides", done: i, total: plan.slides.length });
    const sectionTitle = sections.get(planned.page.id) ?? "Page";
    if (planned.page.id !== currentSection) {
      pptx.addSection({ title: sectionTitle });
      currentSection = planned.page.id;
    }
    const slide = pptx.addSlide({ masterName: options.pageTitles ? "ATELIER_PAGE" : "ATELIER_PAGE_SEULE", sectionTitle });
    if (options.pageTitles) {
      const suffix = planned.parts > 1 ? ` (${planned.part}/${planned.parts})` : "";
      slide.addText(`${planned.page.name}${suffix}`, { placeholder: "title" });
    }
    if (!planned.band.visuals.length) {
      slide.addText("Page vide", { ...contentArea(options.pageTitles), fontSize: 14, color: muted, align: "center", valign: "middle", isTextBox: true });
    }
    const placement = placeBand(planned.band, plan.area);
    const slideWarnings: string[] = [];
    // Ordre du rapport (= ordre d'empilement à l'écran).
    const ordered = planned.page.visuals.filter((v) => planned.band.visuals.includes(v));
    for (const visual of ordered) {
      const built = buildVisual({
        visual: drillView(visual),
        def: VISUALS[visual.type],
        dataset: visual.dataset_id ? profiles.get(visual.dataset_id) : undefined,
        data: data.get(visual.id) ?? { result: null, error: null, colors: null, trend: null },
        rect: placement.rect(visual.layout),
        scale: placement.scale,
        theme,
        mode: options.mode,
        image: images.get(visual.id) ?? null,
        links: {
          slideOf: (id) => plan.firstSlide.get(id),
          page: planned.page.name,
          report: report.name,
          filters: data.get(visual.id)?.filters ?? [],
        },
      });
      addItems(pptx, slide, built.items);
      if (hasData(visual)) {
        if (built.native) nativeVisuals++;
        else imageVisuals++;
      }
      slideWarnings.push(...built.warnings);
    }
    warnings.push(...slideWarnings);
    const summary = planned.part === 1 ? (summaries.get(planned.page.id) ?? []) : [];
    const notes = slideNotes(planned.page, selectionFor(planned.page), profiles, exportedAt, slideWarnings.map((w) => `Attention : ${w}`));
    slide.addNotes(summary.length ? `${summary.join("\n")}\n\n${notes}` : notes);
  }

  onProgress?.({ step: "file", done: 0, total: 1 });
  const blob = (await pptx.write({ outputType: "blob", compression: true })) as Blob;
  onProgress?.({ step: "file", done: 1, total: 1 });
  return {
    blob,
    fileName: fileNameFor(report.name),
    slides: plan.slides.length + (options.titleSlide ? 1 : 0),
    nativeVisuals,
    imageVisuals,
    warnings: [...new Set(warnings)],
  };
}

const hasData = (v: Visual): boolean => VISUALS[v.type].query !== undefined;

/** Télécharge un fichier dans le navigateur (dossier Téléchargements). */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
