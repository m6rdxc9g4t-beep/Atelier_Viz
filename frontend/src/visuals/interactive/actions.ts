/** Logique des boutons d'automatisation : gabarits d'URL et charge utile des webhooks. */

import type { Filter } from "../../types/query";

export type ButtonAction = "url" | "webhook" | "page" | "reset" | "bookmark";

/** Valeurs d'un champ dans les filtres actifs (segments, sélection, filtres de page). */
export function filterValues(filters: Filter[], field: string): string[] {
  return filters
    .filter((f) => f.field === field && (f.op === "in" || f.op === "eq"))
    .flatMap((f) => f.values)
    .filter((v) => v !== null)
    .map(String);
}

/**
 * Remplace les variables d'un gabarit :
 * - {champ} → valeurs filtrées du champ (séparées par des virgules), encodées pour une URL ;
 * - {page}, {rapport}, {date} → contexte.
 * Les variables inconnues deviennent vides.
 */
export function renderTemplate(
  template: string,
  ctx: { filters: Filter[]; page: string; report: string },
  encode = true,
): string {
  const enc = (s: string) => (encode ? encodeURIComponent(s) : s);
  return template.replace(/\{([^{}]+)\}/g, (_, name: string) => {
    const key = name.trim();
    if (key === "page") return enc(ctx.page);
    if (key === "rapport") return enc(ctx.report);
    if (key === "date") return enc(new Date().toISOString().slice(0, 10));
    return enc(filterValues(ctx.filters, key).join(","));
  });
}

/** Seuls http(s) et mailto peuvent être ouverts depuis un bouton. */
export function isSafeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return ["http:", "https:", "mailto:"].includes(u.protocol);
  } catch {
    return false;
  }
}

export function webhookPayload(ctx: { filters: Filter[]; page: string; report: string }) {
  return {
    rapport: ctx.report,
    page: ctx.page,
    filtres: ctx.filters,
    declenche_le: new Date().toISOString(),
  };
}
