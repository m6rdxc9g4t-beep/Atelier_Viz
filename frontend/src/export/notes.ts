/** Textes de l'export : description des filtres (notes du présentateur), noms de fichier, dates. */

import { slicerFilter } from "../studio/filters";
import type { DatasetProfile, Scalar } from "../types/dataset";
import type { Filter } from "../types/query";
import type { Page } from "../types/report";
import { first } from "../visuals/common";
import { bindingLabel } from "../visuals/fields";
import { formatDimension } from "../visuals/format";
import type { Selection } from "../visuals/types";

const OPS: Partial<Record<Filter["op"], string>> = {
  eq: "=",
  neq: "≠",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  contains: "contient",
};

/** « Région : Bretagne, Occitanie » ; « Montant ≥ 1 000 » ; « Date : de 01/01/2026 à 31/03/2026 ». */
export function describeFilter(f: Filter, dataset?: DatasetProfile): string {
  const type = dataset?.columns.find((c) => c.name === f.field)?.type;
  const show = (v: Scalar | undefined) => (v == null ? "…" : formatDimension(v, type, f.bin));
  switch (f.op) {
    case "in":
      return `${f.field} : ${f.values.map(show).join(", ")}`;
    case "not_in":
      return `${f.field} : tout sauf ${f.values.map(show).join(", ")}`;
    case "between":
      return `${f.field} : de ${show(f.values[0])} à ${show(f.values[1])}`;
    case "is_null":
      return `${f.field} : vide`;
    case "not_null":
      return `${f.field} : non vide`;
    default:
      return `${f.field} ${OPS[f.op] ?? f.op} ${show(f.values[0])}`;
  }
}

/** Filtres actifs d'une page, en clair : filtres de page, segments, sélection par clic. */
export function activeFilterTexts(
  page: Page,
  selection: Selection | null,
  profiles: Map<string, DatasetProfile>,
): { page: string[]; slicers: string[]; selection: string[] } {
  const datasetIds = [...new Set(page.visuals.map((v) => v.dataset_id).filter((id): id is string => !!id))];
  const dataset = datasetIds.length === 1 ? profiles.get(datasetIds[0] as string) : undefined;
  const slicers = page.visuals
    .map((v) => {
      const f = slicerFilter(v);
      const field = first(v, "field");
      return f && field ? describeFilter({ ...f, field: bindingLabel(field) }, profiles.get(v.dataset_id ?? "")) : null;
    })
    .filter((s): s is string => s !== null);
  const selected = selection && page.visuals.some((v) => v.id === selection.visualId) ? selection.filters.map((f) => describeFilter(f, dataset)) : [];
  return { page: page.filters.map((f) => describeFilter(f, dataset)), slicers, selection: selected };
}

/** Notes du présentateur d'une diapositive : page, filtres actifs, source, date d'export. */
export function slideNotes(
  page: Page,
  selection: Selection | null,
  profiles: Map<string, DatasetProfile>,
  exportedAt: Date,
  extra: string[] = [],
): string {
  const datasetIds = [...new Set(page.visuals.map((v) => v.dataset_id).filter((id): id is string => !!id))];
  const active = activeFilterTexts(page, selection, profiles);
  const lines = [`Page : ${page.name}`];
  if (active.page.length) lines.push(`Filtres de la page : ${active.page.join(" ; ")}`);
  if (active.slicers.length) lines.push(`Segments : ${active.slicers.join(" ; ")}`);
  if (active.selection.length) lines.push(`Sélection : ${active.selection.join(" ; ")}`);
  if (!active.page.length && !active.slicers.length) lines.push("Aucun filtre : toutes les données.");
  const sources = datasetIds.map((id) => profiles.get(id)?.name).filter(Boolean);
  if (sources.length) lines.push(`Source : ${sources.join(", ")}`);
  lines.push(...extra);
  lines.push(`Exporté le ${formatDate(exportedAt)} depuis Atelier Viz.`);
  return lines.join("\n");
}

export function formatDate(d: Date): string {
  return d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
}

/** Nom de fichier sûr : « Ventes 2026.pptx » (caractères interdits sous Windows retirés). */
export function fileNameFor(reportName: string, ext = "pptx"): string {
  const base = reportName
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "")
    .slice(0, 120);
  return `${base || "Rapport"}.${ext}`;
}
