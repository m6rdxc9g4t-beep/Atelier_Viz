/** État d'édition d'un rapport (zustand) : mutations immuables, historique annuler / rétablir. */

import { create } from "zustand";

import type { ProposedVisual } from "../types/builder";
import type { ColumnProfile } from "../types/dataset";
import type { Filter } from "../types/query";
import type { Bookmark, FieldBinding, Layout, Page, Report, ReportBody, Visual, VisualOptions, VisualType } from "../types/report";
import { defaultBinding } from "../visuals/fields";
import { VISUALS } from "../visuals/registry";
import type { RoleDef, Selection } from "../visuals/types";
import { MAX_BOOKMARKS, applyBookmarkTo, captureBookmark, nextBookmarkName } from "./bookmarks";
import { DEFAULT_PAGE, GAP, clampToPage, fitHeight, migratePage, sizePx } from "./grid";

const MIN_TEXT_H = 72;
import { findFreeSpot, placeVisuals } from "./placement";

export type SaveState = "saved" | "dirty" | "saving" | "error";
export type Mode = "edit" | "view";

const HISTORY = 60;
const lastEdit: { key: string | null; at: number } = { key: null, at: 0 };

export const uid = (): string => Math.random().toString(36).slice(2, 10);

export function bodyOf(r: Report): ReportBody {
  return { name: r.name, dataset_id: r.dataset_id ?? null, pages: r.pages, theme: r.theme, bookmarks: r.bookmarks ?? [] };
}

/** Place un champ dans un rôle (remplace le dernier si le rôle est plein). Retourne une erreur éventuelle. */
export function bindInto(visual: Visual, role: RoleDef, column: ColumnProfile, datasetId: string): string | null {
  if (visual.dataset_id && visual.dataset_id !== datasetId) {
    return "Un visuel utilise un seul jeu de données : créez un autre visuel pour ce jeu.";
  }
  if (column.measure && role.kind === "dimension") {
    return `« ${column.name} » est une mesure calculée : déposez-la dans un emplacement de valeurs.`;
  }
  if (role.types && !role.types.includes(column.type)) {
    return `« ${role.label} » n'accepte pas les champs de type ${column.type}.`;
  }
  visual.dataset_id = datasetId;
  const list = [...(visual.roles[role.id] ?? [])].filter((b) => b.field !== column.name);
  if (role.max && list.length >= role.max) list.splice(role.max - 1);
  list.push(defaultBinding(column, role.kind === "measure"));
  visual.roles[role.id] = list;
  return null;
}

/** Rôle le plus adapté pour un champ déposé directement sur un visuel. */
export function bestRole(visual: Visual, column: ColumnProfile): RoleDef | undefined {
  const def = VISUALS[visual.type];
  const accepts = (r: RoleDef) => !r.types || r.types.includes(column.type);
  // L'Axe accepte une hiérarchie (plusieurs champs) en dépôt explicite ; un clic remplit d'abord les autres rôles.
  const free = (r: RoleDef) => {
    const cap = r.id === "category" ? 1 : r.max;
    return !cap || (visual.roles[r.id]?.length ?? 0) < cap;
  };
  if (column.measure) {
    const measures = def.roles.filter((r) => r.kind === "measure");
    return measures.find(free) ?? measures[0];
  }
  const name = column.name.toLowerCase();
  const named = def.roles.find((r) => accepts(r) && (name.includes(r.id) || (r.id === "lon" && /lng|long/.test(name))));
  if (named) return named;
  const prefer = column.type === "number" ? "measure" : "dimension";
  return (
    def.roles.find((r) => accepts(r) && free(r) && r.kind === prefer) ??
    def.roles.find((r) => accepts(r) && free(r)) ??
    def.roles.find((r) => accepts(r) && r.kind === prefer)
  );
}

/** Conserve les champs lors d'un changement de type de visuel (dimensions puis mesures, dans l'ordre). */
export function convertRoles(visual: Visual, type: VisualType): Record<string, FieldBinding[]> {
  const old = VISUALS[visual.type].roles;
  const dims = old.filter((r) => r.kind === "dimension").flatMap((r) => visual.roles[r.id] ?? []);
  const meas = old.filter((r) => r.kind === "measure").flatMap((r) => visual.roles[r.id] ?? []);
  const out: Record<string, FieldBinding[]> = {};
  // Une hiérarchie d'Axe reste une hiérarchie ; la Légende ne devient pas un niveau d'exploration.
  const levels = Math.max(1, visual.roles.category?.length ?? 0);
  for (const r of VISUALS[type].roles) {
    const pool = r.kind === "dimension" ? dims : meas;
    const cap = r.id === "category" ? Math.min(levels, r.max ?? levels) : r.max;
    const take = cap ? pool.splice(0, cap) : pool.splice(0);
    if (take.length) out[r.id] = r.kind === "measure" ? take.map((b) => ({ ...b, agg: b.agg ?? "sum" })) : take.map((b) => ({ ...b, agg: null }));
  }
  return out;
}

export function newVisual(type: VisualType, page: Page, datasetId: string | null): Visual {
  const def = VISUALS[type];
  const { w, h } = sizePx(def.size);
  return {
    id: uid(),
    type,
    title: null,
    layout: findFreeSpot(page, w, h),
    dataset_id: def.roles.length ? datasetId : null,
    roles: {},
    options: {},
    filters: [],
  };
}

interface StudioState {
  report: Report | null;
  pageId: string;
  selectedId: string | null;
  selection: Selection | null;
  mode: Mode;
  saveState: SaveState;
  saveError: string | null;
  past: ReportBody[];
  future: ReportBody[];
  notice: string | null;

  load: (report: Report) => void;
  /**
   * `coalesce` : clé de regroupement — des modifications rapprochées de même clé (glisser un nuancier,
   * taper un hexadécimal) ne créent qu'une entrée d'historique.
   */
  mutate: (fn: (r: Report) => void, opts?: { history?: boolean; coalesce?: string }) => void;
  setTheme: (theme: Record<string, unknown>) => void;
  /** Ajoute des visuels proposés par l'IA (une seule entrée d'historique) ; retourne leurs identifiants. */
  addGenerated: (specs: ProposedVisual[], datasetId: string) => string[];
  /** Répercute le renommage d'une colonne ou mesure calculée dans les visuels du rapport. */
  renameField: (datasetId: string, from: string, to: string, measure: boolean) => void;
  /** Insère une zone de texte pleine largeur en haut de la page (les visuels descendent). */
  /** Insère un texte pleine largeur en haut de la page (hauteur en px) et descend le reste. */
  insertTextAtTop: (text: string, height: number) => string | null;
  setVisualStyle: (id: string, patch: Record<string, unknown> | null) => void;
  applyStyleToPage: (id: string) => void;
  undo: () => void;
  redo: () => void;
  select: (id: string | null) => void;
  setPage: (id: string) => void;
  setSelection: (s: Selection | null) => void;
  setMode: (m: Mode) => void;
  setSaveState: (s: SaveState, error?: string | null) => void;
  notify: (message: string | null) => void;

  page: () => Page | undefined;
  addVisual: (type: VisualType, datasetId: string | null) => string;
  updateVisual: (id: string, fn: (v: Visual) => void) => void;
  setOptions: (id: string, patch: VisualOptions, history?: boolean) => void;
  removeVisual: (id: string) => void;
  duplicateVisual: (id: string) => void;
  changeType: (id: string, type: VisualType) => void;
  /** Position et taille d'un visuel (px), gardées dans la largeur de la page. */
  setLayout: (id: string, layout: Layout, coalesce?: string) => void;
  /** Déplacement au clavier (flèches : 1 px, Maj : 10 px). */
  nudge: (id: string, dx: number, dy: number) => void;
  /** Ordre d'empilement : premier plan ou arrière-plan. */
  reorder: (id: string, where: "front" | "back") => void;
  setPageSize: (size: { width: number; height: number }) => void;
  dropField: (visualId: string, column: ColumnProfile, datasetId: string, roleId?: string) => void;
  setPageFilters: (filters: Filter[]) => void;
  addPage: () => void;
  renamePage: (id: string, name: string) => void;
  removePage: (id: string) => void;
  duplicatePage: (id: string) => void;
  resetFilters: () => void;

  /** Capture l'état courant dans un nouveau signet ; retourne son identifiant (null si la limite est atteinte). */
  addBookmark: (name?: string) => string | null;
  /** Remplace l'état d'un signet par l'état courant (« Mettre à jour »). */
  updateBookmark: (id: string) => void;
  renameBookmark: (id: string, name: string) => void;
  setBookmarkFlags: (id: string, flags: Partial<Pick<Bookmark, "apply_page" | "apply_data">>) => void;
  removeBookmark: (id: string) => void;
  moveBookmark: (id: string, delta: -1 | 1) => void;
  /** Applique un signet (page, filtres, segments, sélection, exploration). Retourne false s'il est introuvable. */
  applyBookmark: (id: string) => boolean;
}

export const useStudio = create<StudioState>((set, get) => {
  const withPage = (fn: (p: Page, r: Report) => void) =>
    get().mutate((r) => {
      const p = r.pages.find((x) => x.id === get().pageId);
      if (p) fn(p, r);
    });
  const findVisual = (r: Report, id: string) => {
    for (const p of r.pages) {
      const v = p.visuals.find((x) => x.id === id);
      if (v) return { v, p };
    }
    return null;
  };

  return {
    report: null,
    pageId: "",
    selectedId: null,
    selection: null,
    mode: "edit",
    saveState: "saved",
    saveError: null,
    past: [],
    future: [],
    notice: null,

    load: (raw) => {
      // Anciens rapports (grille de 24 colonnes) : convertis en pixels, puis réenregistrés.
      const migrated = raw.pages.some((p) => !p.size);
      const report = migrated ? { ...raw, pages: raw.pages.map(migratePage) } : raw;
      set({
        report,
        pageId: report.pages[0]?.id ?? "",
        selectedId: null,
        selection: null,
        // Converti : enregistré au prochain passage de l'enregistrement automatique.
        saveState: migrated ? "dirty" : "saved",
        saveError: null,
        past: [],
        future: [],
      });
    },

    mutate: (fn, opts) => {
      const current = get().report;
      if (!current) return;
      const next = structuredClone(current);
      fn(next);
      const now = Date.now();
      const merged = !!opts?.coalesce && lastEdit.key === opts.coalesce && now - lastEdit.at < 1200;
      lastEdit.key = opts?.coalesce ?? null;
      lastEdit.at = now;
      const skip = opts?.history === false || merged;
      const past = skip ? get().past : [...get().past, bodyOf(current)].slice(-HISTORY);
      set({ report: next, past, future: skip ? get().future : [], saveState: "dirty" });
    },

    setTheme: (theme) => get().mutate((r) => (r.theme = theme), { coalesce: "theme" }),

    addGenerated: (specs, datasetId) => {
      const page = get().page();
      if (!page || !specs.length) return [];
      const layouts = placeVisuals(page, specs.map((s) => s.type));
      const created: Visual[] = specs.map((spec, i) => ({
        id: uid(),
        type: spec.type,
        title: spec.title,
        layout: layouts[i] ?? { x: GAP, y: GAP, ...sizePx(VISUALS[spec.type].size) },
        dataset_id: datasetId,
        roles: spec.roles,
        options: spec.options,
        filters: [],
      }));
      withPage((p) => {
        p.visuals.push(...created);
        if (p.size) p.size.height = fitHeight(p);
      });
      set({ selectedId: created[0]?.id ?? null });
      return created.map((v) => v.id);
    },

    renameField: (datasetId, from, to, measure) =>
      get().mutate((r) => {
        for (const p of r.pages) {
          for (const v of p.visuals) {
            if (v.dataset_id !== datasetId) continue;
            for (const list of Object.values(v.roles)) {
              for (const b of list) if (b.field === from && (b.agg === "calc") === measure) b.field = to;
            }
            if (!measure) for (const f of v.filters) if (f.field === from) f.field = to;
          }
          if (!measure) for (const f of p.filters) if (f.field === from) f.field = to;
        }
      }),

    insertTextAtTop: (text, height) => {
      const page = get().page();
      if (!page) return null;
      const h = Math.max(MIN_TEXT_H, Math.round(height));
      const width = (page.size ?? DEFAULT_PAGE).width;
      const visual: Visual = {
        id: uid(),
        type: "text",
        title: null,
        layout: { x: GAP, y: GAP, w: width - 2 * GAP, h },
        dataset_id: null,
        roles: {},
        options: { text, size: "sm" },
        filters: [],
      };
      withPage((p) => {
        // Le reste de la page descend d'autant (texte + marge).
        for (const v of p.visuals) v.layout = { ...v.layout, y: v.layout.y + h + GAP };
        p.visuals.unshift(visual);
        if (p.size) p.size.height = fitHeight(p);
      });
      set({ selectedId: visual.id });
      return visual.id;
    },

    setVisualStyle: (id, patch) =>
      get().mutate(
        (r) => {
          for (const p of r.pages) {
            const v = p.visuals.find((x) => x.id === id);
            if (!v) continue;
            if (patch === null) {
              const { style: _removed, ...rest } = v.options;
              v.options = rest;
            } else {
              const style = { ...((v.options.style as Record<string, unknown> | undefined) ?? {}), ...patch };
              for (const k of Object.keys(style)) if (style[k] === undefined) delete style[k];
              v.options = { ...v.options, style };
            }
          }
        },
        { coalesce: patch ? `style:${id}:${Object.keys(patch).join(",")}` : undefined },
      ),

    applyStyleToPage: (id) =>
      get().mutate((r) => {
        for (const p of r.pages) {
          const source = p.visuals.find((x) => x.id === id);
          if (!source) continue;
          const style = source.options.style;
          for (const v of p.visuals) {
            if (v.id === id) continue;
            if (style === undefined) {
              const { style: _removed, ...rest } = v.options;
              v.options = rest;
            } else v.options = { ...v.options, style: structuredClone(style) };
          }
        }
      }),

    undo: () => {
      const { past, report, future } = get();
      const prev = past[past.length - 1];
      if (!prev || !report) return;
      set({
        report: { ...report, ...prev },
        past: past.slice(0, -1),
        future: [bodyOf(report), ...future].slice(0, HISTORY),
        saveState: "dirty",
        selection: null,
      });
      if (!prev.pages.some((p) => p.id === get().pageId)) set({ pageId: prev.pages[0]?.id ?? "" });
    },

    redo: () => {
      const { past, report, future } = get();
      const next = future[0];
      if (!next || !report) return;
      set({ report: { ...report, ...next }, future: future.slice(1), past: [...past, bodyOf(report)], saveState: "dirty" });
    },

    select: (id) => set({ selectedId: id }),
    setPage: (id) => set({ pageId: id, selectedId: null, selection: null }),
    setSelection: (s) => set({ selection: s }),
    setMode: (m) => set({ mode: m, selectedId: m === "view" ? null : get().selectedId }),
    setSaveState: (s, error = null) => set({ saveState: s, saveError: error }),
    notify: (message) => set({ notice: message }),

    page: () => get().report?.pages.find((p) => p.id === get().pageId),

    addVisual: (type, datasetId) => {
      const page = get().page();
      if (!page) return "";
      const v = newVisual(type, page, datasetId);
      withPage((p) => {
        p.visuals.push(v);
        if (p.size) p.size.height = fitHeight(p);
      });
      set({ selectedId: v.id });
      return v.id;
    },

    updateVisual: (id, fn) =>
      get().mutate((r) => {
        const hit = findVisual(r, id);
        if (hit) fn(hit.v);
      }),

    // Les segments écrivent leur sélection ici : pas d'entrée d'historique (ce n'est pas une édition).
    setOptions: (id, patch, history = true) =>
      get().mutate(
        (r) => {
          const hit = findVisual(r, id);
          if (hit) hit.v.options = { ...hit.v.options, ...patch };
        },
        { history },
      ),

    removeVisual: (id) => {
      get().mutate((r) => {
        for (const p of r.pages) p.visuals = p.visuals.filter((v) => v.id !== id);
      });
      set({ selectedId: null, selection: get().selection?.visualId === id ? null : get().selection });
    },

    duplicateVisual: (id) => {
      const copyId = uid();
      get().mutate((r) => {
        const hit = findVisual(r, id);
        if (!hit) return;
        const copy = structuredClone(hit.v);
        copy.id = copyId;
        // Décalé de 16 px, comme dans Power BI ; la page s'agrandit au besoin.
        copy.layout = clampToPage({ ...copy.layout, x: copy.layout.x + GAP, y: copy.layout.y + GAP }, hit.p.size ?? DEFAULT_PAGE);
        hit.p.visuals.push(copy);
        if (hit.p.size) hit.p.size.height = fitHeight(hit.p);
      });
      set({ selectedId: copyId });
    },

    changeType: (id, type) =>
      get().updateVisual(id, (v) => {
        v.roles = convertRoles(v, type);
        v.type = type;
        if (!VISUALS[type].roles.length) v.dataset_id = null;
      }),

    setLayout: (id, layout, coalesce) => {
      const page = get().page();
      const v = page?.visuals.find((x) => x.id === id);
      if (!page || !v) return;
      const next = clampToPage(layout, page.size ?? DEFAULT_PAGE);
      if (next.x === v.layout.x && next.y === v.layout.y && next.w === v.layout.w && next.h === v.layout.h) return;
      get().mutate(
        (r) => {
          const p = r.pages.find((x) => x.id === get().pageId);
          const target = p?.visuals.find((x) => x.id === id);
          if (!p || !target) return;
          target.layout = next satisfies Layout;
          // La page s'allonge si un visuel dépasse le bas (jamais raccourcie automatiquement).
          if (p.size) p.size.height = fitHeight(p);
        },
        coalesce ? { coalesce } : undefined,
      );
    },

    nudge: (id, dx, dy) => {
      const v = get().page()?.visuals.find((x) => x.id === id);
      if (v) get().setLayout(id, { ...v.layout, x: v.layout.x + dx, y: v.layout.y + dy }, `nudge:${id}`);
    },

    reorder: (id, where) =>
      withPage((p) => {
        const i = p.visuals.findIndex((v) => v.id === id);
        if (i < 0) return;
        const [v] = p.visuals.splice(i, 1);
        if (!v) return;
        if (where === "front") p.visuals.push(v);
        else p.visuals.unshift(v);
      }),

    setPageSize: (size) =>
      withPage((p) => {
        p.size = { width: Math.round(size.width), height: Math.round(size.height) };
        for (const v of p.visuals) v.layout = clampToPage(v.layout, p.size);
        p.size.height = Math.max(p.size.height, fitHeight({ ...p, size: { ...p.size, height: 0 } }));
      }),

    dropField: (visualId, column, datasetId, roleId) => {
      const report = get().report;
      const hit = report ? findVisual(report, visualId) : null;
      if (!hit) return;
      // Essai sur une copie : on ne touche à l'historique que si le dépôt est valide.
      const trial = structuredClone(hit.v);
      const def = VISUALS[trial.type];
      const role = roleId ? def.roles.find((r) => r.id === roleId) : bestRole(trial, column);
      const error = role ? bindInto(trial, role, column, datasetId) : `Ce visuel ne peut pas utiliser « ${column.name} ».`;
      if (error) {
        set({ notice: error });
        return;
      }
      get().updateVisual(visualId, (v) => {
        v.dataset_id = trial.dataset_id;
        v.roles = trial.roles;
      });
    },

    setPageFilters: (filters) => withPage((p) => (p.filters = filters)),

    addPage: () => {
      const id = uid();
      get().mutate((r) => r.pages.push({ id, name: `Page ${r.pages.length + 1}`, visuals: [], filters: [], size: { ...(get().page()?.size ?? DEFAULT_PAGE) } }));
      set({ pageId: id, selectedId: null, selection: null });
    },

    renamePage: (id, name) =>
      get().mutate((r) => {
        const p = r.pages.find((x) => x.id === id);
        if (p && name.trim()) p.name = name.trim();
      }),

    removePage: (id) => {
      const report = get().report;
      if (!report || report.pages.length <= 1) return;
      const index = report.pages.findIndex((p) => p.id === id);
      get().mutate((r) => (r.pages = r.pages.filter((p) => p.id !== id)));
      const pages = get().report?.pages ?? [];
      set({ pageId: pages[Math.max(0, index - 1)]?.id ?? "", selectedId: null, selection: null });
    },

    duplicatePage: (id) => {
      const newId = uid();
      get().mutate((r) => {
        const p = r.pages.find((x) => x.id === id);
        if (!p) return;
        const copy = structuredClone(p);
        copy.id = newId;
        copy.name = `${p.name} (copie)`;
        copy.visuals = copy.visuals.map((v) => ({ ...v, id: uid() }));
        r.pages.splice(r.pages.indexOf(p) + 1, 0, copy);
      });
      set({ pageId: newId, selectedId: null, selection: null });
    },

    addBookmark: (name) => {
      const { report, pageId, selection } = get();
      if (!report) return null;
      const list = report.bookmarks ?? [];
      if (list.length >= MAX_BOOKMARKS) {
        set({ notice: `${MAX_BOOKMARKS} signets au plus par rapport.` });
        return null;
      }
      const bookmark = captureBookmark(report, pageId, selection, { id: uid(), name: name?.trim() || nextBookmarkName(list) });
      get().mutate((r) => (r.bookmarks = [...(r.bookmarks ?? []), bookmark]));
      return bookmark.id;
    },

    updateBookmark: (id) => {
      const { report, pageId, selection } = get();
      const base = report?.bookmarks?.find((b) => b.id === id);
      if (!report || !base) return;
      const fresh = captureBookmark(report, pageId, selection, { id, name: base.name, base });
      get().mutate((r) => (r.bookmarks = (r.bookmarks ?? []).map((b) => (b.id === id ? fresh : b))));
    },

    renameBookmark: (id, name) =>
      get().mutate((r) => {
        const b = r.bookmarks?.find((x) => x.id === id);
        if (b && name.trim()) b.name = name.trim().slice(0, 80);
      }),

    setBookmarkFlags: (id, flags) =>
      get().mutate((r) => {
        const b = r.bookmarks?.find((x) => x.id === id);
        if (b) Object.assign(b, flags);
      }),

    removeBookmark: (id) => get().mutate((r) => (r.bookmarks = (r.bookmarks ?? []).filter((b) => b.id !== id))),

    moveBookmark: (id, delta) =>
      get().mutate((r) => {
        const list = r.bookmarks ?? [];
        const i = list.findIndex((b) => b.id === id);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= list.length) return;
        const [b] = list.splice(i, 1);
        if (b) list.splice(j, 0, b);
      }),

    applyBookmark: (id) => {
      const { report, pageId, selection } = get();
      const bookmark = report?.bookmarks?.find((b) => b.id === id);
      if (!report || !bookmark) return false;
      let applied: ReturnType<typeof applyBookmarkTo> | null = null;
      // Comme un segment : pas une édition, donc pas d'entrée d'historique.
      get().mutate((r) => (applied = applyBookmarkTo(r, bookmark, pageId, selection)), { history: false });
      const result = applied as ReturnType<typeof applyBookmarkTo> | null;
      if (!result) return false;
      set({
        pageId: result.pageId,
        selection: result.selection,
        selectedId: result.pageId === pageId ? get().selectedId : null,
        notice: result.missing ? `Signet « ${bookmark.name} » appliqué ; ${result.missing} élément(s) supprimé(s) depuis ont été ignorés.` : get().notice,
      });
      return true;
    },

    resetFilters: () => {
      set({ selection: null });
      withPage((p) => {
        p.filters = [];
        for (const v of p.visuals) {
          if (v.type === "slicer") v.options = { ...v.options, selected: [], range: [null, null] };
        }
      });
    },
  };
});
