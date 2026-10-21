/** Pages d'extraction (drill-through) et mode présentation : logique pure, testée. */

import type { Filter } from "../types/query";
import { formatDimension } from "../visuals/format";
import type { Page, Report } from "../types/report";
import type { Selection } from "../visuals/types";

/** Extraction active : la page cible affiche ces filtres et un bouton « Retour ». */
export interface Extraction {
  pageId: string;
  fromPageId: string;
  datasetId: string;
  filters: Filter[];
}

/** Le champ d'un filtre correspond-il à un champ d'extraction ? (« region » ↔ « regions.region »). */
export function sameField(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/** Pages d'extraction atteignables depuis une sélection, avec les filtres qu'elles reçoivent. */
export function drillTargets(report: Report, fromPageId: string, selection: Selection | null): { page: Page; filters: Filter[] }[] {
  if (!selection) return [];
  return report.pages
    .filter((p) => p.id !== fromPageId && p.drillthrough?.fields.length)
    .map((page) => ({
      page,
      filters: selection.filters.filter((f) => page.drillthrough?.fields.some((name) => sameField(f.field, name))),
    }))
    .filter((t) => t.filters.length > 0);
}

/** « region = Occitanie », « date = mars 2026, region = Occitanie ou Bretagne ». */
export function extractionLabel(filters: Filter[]): string {
  return filters
    .map((f) => {
      const values = f.values ?? [];
      const show = (v: (typeof values)[number]) => (v === null || v === undefined ? "(vide)" : f.bin ? formatDimension(v, "date", f.bin) : String(v));
      const shown = values.slice(0, 3).map(show).join(" ou ") + (values.length > 3 ? "…" : "");
      return `${f.field} = ${shown}`;
    })
    .join(", ");
}

/** Pages déroulées en présentation : les pages d'extraction ne s'atteignent que par clic droit. */
export function presentationPages(report: Report): Page[] {
  const pages = report.pages.filter((p) => !p.drillthrough);
  return pages.length ? pages : report.pages;
}

/** Indice suivant ou précédent, en boucle. */
export function step(index: number, count: number, delta: number): number {
  if (count <= 0) return 0;
  return (((index + delta) % count) + count) % count;
}

/** Échelle pour faire tenir toute la page dans la zone (marges comprises), entre 0,1 et 4. */
/**
 * Zoom « ajuster à la largeur » : la page occupe la largeur disponible moins les marges, bornée à 25 %–200 %.
 * Arrondi vers le bas au millième (et 1 px de marge) : jamais de débordement d'un sous-pixel, qui ferait
 * apparaître une barre de défilement, changerait la largeur disponible, donc le zoom, et ainsi de suite.
 */
export function fitWidthScale(pageWidth: number, available: number, margin = 0): number {
  if (available <= 0 || pageWidth <= 0) return 1;
  const s = Math.floor(((available - 2 * margin - 1) / pageWidth) * 1000) / 1000;
  return Math.min(2, Math.max(0.25, s));
}

export function fitScale(page: { width: number; height: number }, area: { width: number; height: number }, margin = 0): number {
  if (area.width <= 0 || area.height <= 0) return 1;
  const s = Math.min((area.width - 2 * margin) / page.width, (area.height - 2 * margin) / page.height);
  return Math.min(4, Math.max(0.1, s));
}
