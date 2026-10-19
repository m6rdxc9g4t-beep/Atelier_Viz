/** Titres des visuels. */

import type { Visual } from "../types/report";
import { VISUALS } from "./registry";

/** Titre automatique : « Somme de ca par région » (comme Power BI). */
export function defaultTitle(visual: Visual): string {
  const def = VISUALS[visual.type];
  const measures = def.roles.filter((r) => r.kind === "measure").flatMap((r) => visual.roles[r.id] ?? []);
  const dims = def.roles
    .filter((r) => r.kind === "dimension" && r.id !== "lat" && r.id !== "lon")
    .flatMap((r) => visual.roles[r.id] ?? []);
  if (!measures.length && !dims.length) return def.label;
  const m = measures.map((b) => (b.agg === "count" ? `Nombre de ${b.field}` : b.agg === "avg" ? `Moyenne de ${b.field}` : b.field)).join(", ");
  const names = dims.map((b) => b.field);
  const d = names.length > 1 ? `${names.slice(0, -1).join(", ")} et ${names[names.length - 1]}` : (names[0] ?? "");
  return m && d ? `${m} par ${d}` : m || d;
}
