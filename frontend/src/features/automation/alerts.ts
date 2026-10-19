/** Logique des alertes (libellés, brouillons, contrôles) — pure et testée. */

import type { Alert, AlertInput, Comparison } from "../../types/alert";
import type { ColumnProfile, DatasetProfile, Scalar } from "../../types/dataset";
import type { Filter, FilterOp, Measure } from "../../types/query";
import type { Visual } from "../../types/report";
import { first } from "../../visuals/common";
import { AGG_LABELS, measure as toMeasure } from "../../visuals/fields";

export const COMPARISONS: { value: Comparison; symbol: string; label: string }[] = [
  { value: "gt", symbol: ">", label: "supérieur à" },
  { value: "gte", symbol: "≥", label: "supérieur ou égal à" },
  { value: "lt", symbol: "<", label: "inférieur à" },
  { value: "lte", symbol: "≤", label: "inférieur ou égal à" },
  { value: "eq", symbol: "=", label: "égal à" },
  { value: "neq", symbol: "≠", label: "différent de" },
];

export const SYMBOL: Record<Comparison, string> = Object.fromEntries(COMPARISONS.map((c) => [c.value, c.symbol])) as Record<Comparison, string>;

const numberFmt = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 2 });
export const formatAlertNumber = (n: number): string => numberFmt.format(n);

/** « Somme de ca », « Marge » (mesure calculée), « Nombre de lignes ». */
export function measureLabel(m: Measure): string {
  if (!m.field) return "Nombre de lignes";
  if (m.agg === "calc") return m.field;
  return `${AGG_LABELS[m.agg]} de ${m.field}`;
}

/** « Somme de ca > 150 000 ». */
export function conditionLabel(a: Pick<AlertInput, "measure" | "comparison" | "threshold">): string {
  return `${measureLabel(a.measure)} ${SYMBOL[a.comparison]} ${formatAlertNumber(a.threshold)}`;
}

const OP_SYMBOL: Partial<Record<FilterOp, string>> = { eq: "=", neq: "≠", gt: ">", gte: "≥", lt: "<", lte: "≤", in: "∈", not_in: "∉", contains: "contient" };

export function filterLabel(f: Filter): string {
  const values = f.values.map((v) => (v === null ? "(vide)" : String(v))).join(", ");
  if (f.op === "between") return `${f.field} entre ${f.values[0] ?? "…"} et ${f.values[1] ?? "…"}`;
  if (f.op === "is_null") return `${f.field} vide`;
  if (f.op === "not_null") return `${f.field} renseigné`;
  return `${f.field} ${OP_SYMBOL[f.op] ?? f.op} ${values}`;
}

export type AlertStatus = "fired" | "ok" | "never" | "error" | "off";

/** État affiché d'une alerte. */
export function alertStatus(a: Alert): AlertStatus {
  if (!a.enabled) return "off";
  const last = a.history[0];
  if (last?.error && a.met === null) return "error";
  if (a.met === true) return "fired";
  if (a.met === false) return "ok";
  return last?.error ? "error" : "never";
}

export const STATUS_TEXT: Record<AlertStatus, string> = {
  fired: "Seuil franchi",
  ok: "Sous contrôle",
  never: "Jamais évaluée",
  error: "Erreur",
  off: "Désactivée",
};

export function emptyAlert(datasetId: string): AlertInput {
  return { name: "", dataset_id: datasetId, measure: { field: null, agg: "count" }, filters: [], comparison: "gt", threshold: 0, enabled: true, notify: true, webhook: null };
}

/**
 * Brouillon d'alerte depuis un visuel KPI ou jauge : même mesure, mêmes filtres (page, segments,
 * visuel), seuil = cible si elle existe, sinon valeur affichée. `null` si le visuel ne s'y prête pas.
 */
export function alertFromVisual(visual: Visual, filters: Filter[], values: { value: number | null; target: number | null }): AlertInput | null {
  if (!visual.dataset_id || !(visual.type === "kpi" || visual.type === "gauge")) return null;
  const b = first(visual, "values");
  if (!b) return null;
  const m = toMeasure(b);
  const threshold = values.target ?? values.value ?? 0;
  return {
    ...emptyAlert(visual.dataset_id),
    name: visual.title || measureLabel(m),
    measure: m,
    filters: structuredClone(filters),
    comparison: values.target !== null ? "lt" : "gt",
    threshold: Math.round(threshold * 100) / 100,
  };
}

/** Erreur de saisie (null si l'alerte peut être enregistrée). */
export function alertError(a: AlertInput, profile: DatasetProfile | undefined): string | null {
  if (!a.name.trim()) return "Donnez un nom à l'alerte.";
  if (!Number.isFinite(a.threshold)) return "Le seuil doit être un nombre.";
  if (!a.notify && !a.webhook) return "Choisissez au moins une action : notification ou webhook.";
  if (a.webhook && !/^https?:\/\/\S+$/i.test(a.webhook.url.trim())) return "Adresse du webhook invalide (http ou https).";
  if (profile && a.measure.field) {
    const known = a.measure.agg === "calc" ? (profile.model?.measures ?? []).some((m) => m.name === a.measure.field) : profile.columns.some((c) => c.name === a.measure.field);
    if (!known) return `Champ inconnu : « ${a.measure.field} ».`;
  }
  return null;
}

/** Convertit une saisie de filtre (texte) en valeurs typées selon la colonne. */
export function parseFilterValues(raw: string, column: ColumnProfile | undefined, op: FilterOp): Scalar[] {
  const parts = op === "in" || op === "not_in" ? raw.split(";").map((s) => s.trim()).filter(Boolean) : [raw.trim()];
  return parts.map((p) => {
    if (column?.type === "number") {
      const n = Number(p.replace(/\s/g, "").replace(",", "."));
      return Number.isFinite(n) ? n : p;
    }
    if (column?.type === "boolean") return /^(vrai|true|oui|1)$/i.test(p);
    return p;
  });
}
