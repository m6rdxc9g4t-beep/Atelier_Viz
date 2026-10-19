/**
 * Signets (comme dans Power BI) : capture et application de l'état d'un rapport.
 *
 * Un signet retient, pour chaque page : ses filtres, la sélection de ses segments et le niveau
 * d'exploration de ses visuels ; plus la page affichée et le filtrage croisé en cours.
 * Fonctions pures (testées dans `bookmarks.test.ts`) ; le store les appelle sur une copie du rapport.
 */

import type { Bookmark, BookmarkPageState, BookmarkVisualState, Page, Report, Visual } from "../types/report";
import type { Scalar } from "../types/dataset";
import { DRILLABLE } from "../visuals/drill";
import type { Selection } from "../visuals/types";

export const MAX_BOOKMARKS = 100;

/** Les visuels dont l'état est capturé : segments et visuels explorables. */
function captured(v: Visual): boolean {
  return v.type === "slicer" || DRILLABLE.has(v.type);
}

function visualState(v: Visual): BookmarkVisualState {
  if (v.type === "slicer") {
    return {
      selected: structuredClone((v.options.selected as Scalar[] | undefined) ?? []),
      range: structuredClone((v.options.range as Scalar[] | undefined) ?? [null, null]),
    };
  }
  const drill = v.options.drill as Record<string, unknown> | undefined;
  return { drill: drill ? structuredClone(drill) : null };
}

function pageState(page: Page): BookmarkPageState {
  const visuals: Record<string, BookmarkVisualState> = {};
  for (const v of page.visuals) if (captured(v)) visuals[v.id] = visualState(v);
  return { filters: structuredClone(page.filters), visuals };
}

/** Nom proposé pour un nouveau signet (« Signet 3 »), sans doublon. */
export function nextBookmarkName(bookmarks: Bookmark[]): string {
  const names = new Set(bookmarks.map((b) => b.name));
  let n = bookmarks.length + 1;
  while (names.has(`Signet ${n}`)) n += 1;
  return `Signet ${n}`;
}

/**
 * Capture l'état courant du rapport sous un nom.
 * La sélection (filtrage croisé) n'est gardée que si son visuel est sur la page affichée.
 */
export function captureBookmark(
  report: Report,
  pageId: string,
  selection: Selection | null,
  init: { id: string; name: string; now?: string; base?: Bookmark },
): Bookmark {
  const pages: Record<string, BookmarkPageState> = {};
  for (const p of report.pages) pages[p.id] = pageState(p);
  const page = report.pages.find((p) => p.id === pageId);
  const keepSelection = !!selection && !!page?.visuals.some((v) => v.id === selection.visualId);
  const now = init.now ?? new Date().toISOString();
  return {
    id: init.id,
    name: init.name,
    page_id: pageId || null,
    apply_page: init.base?.apply_page ?? true,
    apply_data: init.base?.apply_data ?? true,
    pages,
    selection:
      keepSelection && selection
        ? { visual_id: selection.visualId, dataset_id: selection.datasetId, filters: structuredClone(selection.filters), keys: [...selection.keys] }
        : null,
    created_at: init.base?.created_at ?? now,
    updated_at: now,
  };
}

export interface AppliedBookmark {
  /** Page à afficher (inchangée si le signet n'applique pas la page ou si elle a été supprimée). */
  pageId: string;
  selection: Selection | null;
  /** Visuels ou pages du signet qui n'existent plus (pour informer l'utilisateur). */
  missing: number;
}

/**
 * Applique un signet sur `draft` (copie modifiable du rapport).
 * - Pages et visuels supprimés depuis la capture : ignorés (comptés dans `missing`).
 * - Visuels ajoutés depuis la capture : laissés tels quels.
 */
export function applyBookmarkTo(draft: Report, bookmark: Bookmark, currentPageId: string, currentSelection: Selection | null): AppliedBookmark {
  let missing = 0;
  const targetPage = bookmark.page_id && draft.pages.some((p) => p.id === bookmark.page_id) ? bookmark.page_id : null;
  if (bookmark.apply_page && bookmark.page_id && !targetPage) missing += 1;
  const pageId = bookmark.apply_page && targetPage ? targetPage : currentPageId;

  if (!bookmark.apply_data) {
    return { pageId, selection: pageId === currentPageId ? currentSelection : null, missing };
  }

  for (const [id, state] of Object.entries(bookmark.pages)) {
    const page = draft.pages.find((p) => p.id === id);
    if (!page) {
      missing += 1;
      continue;
    }
    page.filters = structuredClone(state.filters);
    for (const [visualId, vs] of Object.entries(state.visuals)) {
      const v = page.visuals.find((x) => x.id === visualId);
      if (!v) {
        missing += 1;
        continue;
      }
      if (v.type === "slicer") {
        v.options = { ...v.options, selected: structuredClone(vs.selected ?? []), range: structuredClone(vs.range ?? [null, null]) };
      } else if (DRILLABLE.has(v.type)) {
        const { drill: _old, ...rest } = v.options;
        v.options = vs.drill ? { ...rest, drill: structuredClone(vs.drill) } : rest;
      }
    }
  }

  const sel = bookmark.selection;
  const selPage = draft.pages.find((p) => p.id === pageId);
  const selection: Selection | null =
    sel && selPage?.visuals.some((v) => v.id === sel.visual_id)
      ? { visualId: sel.visual_id, datasetId: sel.dataset_id, filters: structuredClone(sel.filters), keys: [...sel.keys] }
      : null;
  return { pageId, selection, missing };
}

/** Résumé lisible d'un signet (« Page Ventes · 2 filtres · 1 segment »). */
export function describeBookmark(report: Report, bookmark: Bookmark): string {
  const parts: string[] = [];
  const page = report.pages.find((p) => p.id === bookmark.page_id);
  if (bookmark.apply_page) parts.push(page ? page.name : "page supprimée");
  if (bookmark.apply_data) {
    const states = Object.values(bookmark.pages);
    const filters = states.reduce((n, s) => n + s.filters.length, 0);
    const slicers = states.reduce(
      (n, s) => n + Object.values(s.visuals).filter((v) => (v.selected?.length ?? 0) > 0 || (v.range ?? []).some((x) => x !== null)).length,
      0,
    );
    if (filters) parts.push(`${filters} filtre${filters > 1 ? "s" : ""}`);
    if (slicers) parts.push(`${slicers} segment${slicers > 1 ? "s" : ""}`);
    if (bookmark.selection) parts.push("sélection");
    if (!filters && !slicers && !bookmark.selection) parts.push("sans filtre");
  }
  return parts.join(" · ") || "Aucun effet (page et données décochées)";
}
