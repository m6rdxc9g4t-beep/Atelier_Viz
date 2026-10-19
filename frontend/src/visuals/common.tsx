/** Briques partagées par les visuels : requête générique, couleurs, info-bulle, sélection. */

import clsx from "clsx";
import type { ReactNode } from "react";

import type { Scalar } from "../types/dataset";
import type { Filter, QueryRequest, Sort } from "../types/query";
import type { FieldBinding, Visual } from "../types/report";
import { bindingKey, dimension, measure } from "./fields";
import type { NumberFormat } from "./format";
import type { OptionDef, Selection, VisualDef } from "./types";

/**
 * Position de la souris dans un élément, en px CSS de l'élément : corrige l'échelle du canvas
 * (zoom de la page par `transform: scale`) pour placer une info-bulle maison au bon endroit.
 */
export function localPoint(e: { clientX: number; clientY: number }, el: Element | null | undefined): { x: number; y: number } {
  if (!el) return { x: e.clientX, y: e.clientY };
  const r = el.getBoundingClientRect();
  const sx = el.clientWidth > 0 ? r.width / el.clientWidth : 1;
  const sy = el.clientHeight > 0 ? r.height / el.clientHeight : 1;
  return { x: (e.clientX - r.left) / (sx || 1), y: (e.clientY - r.top) / (sy || 1) };
}

export const MAX_SERIES = 8;

/** Couleur catégorielle n°i (ordre fixe validé ; au-delà de 8 on regroupe en « Autres »). */
export const seriesColor = (i: number): string => `var(--series-${Math.min(i, MAX_SERIES - 1) + 1})`;
export const OTHER_COLOR = "var(--muted)";

export function role(visual: Visual, id: string): FieldBinding[] {
  return visual.roles[id] ?? [];
}

export function first(visual: Visual, id: string): FieldBinding | undefined {
  return role(visual, id)[0];
}

/** Rôles obligatoires remplis ? */
export function isReady(visual: Visual, def: VisualDef): boolean {
  return def.roles.every((r) => !r.required || role(visual, r.id).length > 0);
}

export type SortMode = "category" | "value_desc" | "value_asc";

/**
 * Requête par défaut : dimensions = rôles « dimension » (dans l'ordre), mesures = rôles « mesure ».
 * Tri et Top N viennent des options `sort` et `topN`.
 */
export function genericQuery(visual: Visual, def: VisualDef, filters: Filter[], limit = 2000): QueryRequest | null {
  if (!visual.dataset_id || !isReady(visual, def)) return null;
  const dims = def.roles.filter((r) => r.kind === "dimension").flatMap((r) => role(visual, r.id));
  const meas = def.roles.filter((r) => r.kind === "measure").flatMap((r) => role(visual, r.id));
  if (!dims.length && !meas.length) return null;

  const sortMode = (visual.options.sort ?? def.defaults.sort ?? "category") as SortMode;
  const sort: Sort[] = [];
  const firstMeasure = meas[0];
  if (sortMode !== "category" && firstMeasure) sort.push({ key: bindingKey(firstMeasure), desc: sortMode === "value_desc" });
  const topN = Number(visual.options.topN ?? 0);

  return {
    dataset_id: visual.dataset_id,
    dimensions: dims.map(dimension),
    measures: meas.map(measure),
    filters,
    sort,
    limit: topN > 0 ? topN : limit,
  };
}

export function numberFormat(visual: Visual): NumberFormat {
  const o = visual.options;
  return {
    decimals: typeof o.decimals === "number" ? o.decimals : undefined,
    compact: o.compact === true,
    prefix: typeof o.prefix === "string" ? o.prefix : undefined,
    suffix: typeof o.suffix === "string" ? o.suffix : undefined,
  };
}

export const NUMBER_OPTIONS: OptionDef[] = [
  { key: "compact", label: "Notation compacte (k, M)", type: "boolean", section: "Valeurs" },
  { key: "decimals", label: "Décimales", type: "number", min: 0, max: 6, section: "Valeurs" },
  { key: "prefix", label: "Préfixe", type: "text", placeholder: "ex. $", section: "Valeurs" },
  { key: "suffix", label: "Suffixe", type: "text", placeholder: "ex.  €", section: "Valeurs" },
];

export const SORT_OPTIONS: OptionDef[] = [
  {
    key: "sort",
    label: "Tri",
    type: "select",
    section: "Données",
    choices: [
      { value: "category", label: "Par catégorie" },
      { value: "value_desc", label: "Valeur décroissante" },
      { value: "value_asc", label: "Valeur croissante" },
    ],
  },
  { key: "topN", label: "Top N (0 = tout)", type: "number", min: 0, max: 1000, section: "Données" },
];

export const LEGEND_OPTION: OptionDef = { key: "legend", label: "Légende", type: "boolean", section: "Affichage" };
export const LABELS_OPTION: OptionDef = {
  key: "labels",
  label: "Étiquettes de données",
  type: "boolean",
  section: "Affichage",
};

/** Clé stable d'une valeur (sélection, React keys). */
export const valueKey = (v: Scalar): string => (v === null ? "∅" : String(v));

/** Clic sur un élément : sélectionne, ou désélectionne s'il l'était déjà (filtrage croisé). */
export function toggleSelection(
  current: Selection | null,
  visual: Visual,
  binding: FieldBinding,
  value: Scalar,
  onSelect: (s: Selection | null) => void,
): void {
  const key = valueKey(value);
  if (!visual.dataset_id) return;
  if (current?.visualId === visual.id && current.keys.length === 1 && current.keys[0] === key) {
    onSelect(null);
    return;
  }
  onSelect({
    visualId: visual.id,
    datasetId: visual.dataset_id,
    keys: [key],
    filters: [{ field: binding.field, op: "in", values: [value], bin: binding.bin ?? null }],
  });
}

/** Opacité d'un élément selon la sélection active du visuel. */
export function dimmed(selection: Selection | null, visual: Visual, value: Scalar): boolean {
  return selection?.visualId === visual.id && !selection.keys.includes(valueKey(value));
}

export function VisualMessage({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "error" }) {
  return (
    <div
      className={clsx(
        "flex h-full items-center justify-center p-3 text-center text-xs",
        tone === "error" ? "text-negative" : "text-muted",
      )}
    >
      {children}
    </div>
  );
}

interface TooltipRow {
  color?: string;
  label: string;
  value: string;
}

export function TooltipBox({ title, rows }: { title?: string; rows: TooltipRow[] }) {
  return (
    <div className="pointer-events-none min-w-36 rounded-md border border-border bg-surface px-3 py-2 text-xs shadow-lg">
      {title && <p className="mb-1 font-medium text-fg">{title}</p>}
      {rows.map((r) => (
        <p key={r.label} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-muted">
            {r.color && <span className="size-2 rounded-full" style={{ background: r.color }} aria-hidden />}
            {r.label}
          </span>
          <span className="font-medium tabular-nums text-fg">{r.value}</span>
        </p>
      ))}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  if (items.length < 2) return null;
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 px-1 pb-1 text-[11px] text-muted">
      {items.map((it) => (
        <li key={it.label} className="flex items-center gap-1.5">
          <span className="size-2 rounded-full" style={{ background: it.color }} aria-hidden />
          {it.label}
        </li>
      ))}
    </ul>
  );
}

export const AXIS = {
  stroke: "var(--muted)",
  fontSize: 11,
  tickLine: false,
  axisLine: { stroke: "var(--grid)" },
} as const;
