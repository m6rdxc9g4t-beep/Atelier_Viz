/** État d'édition d'un rapport (zustand) : mutations immuables, historique annuler / rétablir. */

import { create } from "zustand";

import type { ColumnProfile } from "../types/dataset";
import type { Filter } from "../types/query";
import type { FieldBinding, Layout, Page, Report, ReportBody, Visual, VisualOptions, VisualType } from "../types/report";
import { defaultBinding } from "../visuals/fields";
import { VISUALS } from "../visuals/registry";
import type { RoleDef, Selection } from "../visuals/types";

export type SaveState = "saved" | "dirty" | "saving" | "error";
export type Mode = "edit" | "view";

const HISTORY = 60;
const lastEdit: { key: string | null; at: number } = { key: null, at: 0 };

export const uid = (): string => Math.random().toString(36).slice(2, 10);

export function bodyOf(r: Report): ReportBody {
  return { name: r.name, dataset_id: r.dataset_id ?? null, pages: r.pages, theme: r.theme };
}

/** Place un champ dans un rôle (remplace le dernier si le rôle est plein). Retourne une erreur éventuelle. */
export function bindInto(visual: Visual, role: RoleDef, column: ColumnProfile, datasetId: string): string | null {
  if (visual.dataset_id && visual.dataset_id !== datasetId) {
    return "Un visuel utilise un seul jeu de données : créez un autre visuel pour ce jeu.";
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
  const free = (r: RoleDef) => !r.max || (visual.roles[r.id]?.length ?? 0) < r.max;
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
  for (const r of VISUALS[type].roles) {
    const pool = r.kind === "dimension" ? dims : meas;
    const take = r.max ? pool.splice(0, r.max) : pool.splice(0);
    if (take.length) out[r.id] = r.kind === "measure" ? take.map((b) => ({ ...b, agg: b.agg ?? "sum" })) : take.map((b) => ({ ...b, agg: null }));
  }
  return out;
}

export function newVisual(type: VisualType, page: Page, datasetId: string | null): Visual {
  const def = VISUALS[type];
  const bottom = page.visuals.reduce((m, v) => Math.max(m, v.layout.y + v.layout.h), 0);
  return {
    id: uid(),
    type,
    title: null,
    layout: { x: 0, y: bottom, ...def.size },
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
  setLayouts: (items: readonly { i: string; x: number; y: number; w: number; h: number }[]) => void;
  dropField: (visualId: string, column: ColumnProfile, datasetId: string, roleId?: string) => void;
  setPageFilters: (filters: Filter[]) => void;
  addPage: () => void;
  renamePage: (id: string, name: string) => void;
  removePage: (id: string) => void;
  duplicatePage: (id: string) => void;
  resetFilters: () => void;
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

    load: (report) =>
      set({
        report,
        pageId: report.pages[0]?.id ?? "",
        selectedId: null,
        selection: null,
        saveState: "saved",
        saveError: null,
        past: [],
        future: [],
      }),

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
      withPage((p) => p.visuals.push(v));
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
        copy.layout = { ...copy.layout, y: copy.layout.y + copy.layout.h };
        hit.p.visuals.push(copy);
      });
      set({ selectedId: copyId });
    },

    changeType: (id, type) =>
      get().updateVisual(id, (v) => {
        v.roles = convertRoles(v, type);
        v.type = type;
        if (!VISUALS[type].roles.length) v.dataset_id = null;
      }),

    setLayouts: (items) => {
      const page = get().page();
      if (!page) return;
      const changed = items.some((it) => {
        const v = page.visuals.find((x) => x.id === it.i);
        return v && (v.layout.x !== it.x || v.layout.y !== it.y || v.layout.w !== it.w || v.layout.h !== it.h);
      });
      if (!changed) return;
      withPage((p) => {
        for (const it of items) {
          const v = p.visuals.find((x) => x.id === it.i);
          if (v) v.layout = { x: it.x, y: it.y, w: it.w, h: it.h } satisfies Layout;
        }
      });
    },

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
      get().mutate((r) => r.pages.push({ id, name: `Page ${r.pages.length + 1}`, visuals: [], filters: [] }));
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
