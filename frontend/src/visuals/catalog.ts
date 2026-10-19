/** Catalogue des visuels transmis à l'IA (dérivé du registre : une seule source de vérité). */

import type { VisualTypeSpec } from "../types/builder";
import type { VisualType } from "../types/report";
import { VISUALS } from "./registry";

/** Visuels sans données (bouton, texte) : hors du périmètre de l'IA. */
const EXCLUDED_TYPES: VisualType[] = ["button", "text"];

/** Options de présentation fine : inutiles à l'IA, elles allongeraient le prompt. */
const EXCLUDED_OPTIONS = new Set(["prefix", "suffix", "decimals", "label", "url", "method", "confirm", "targetPage", "variant", "text"]);

export function aiCatalog(): VisualTypeSpec[] {
  return Object.values(VISUALS)
    .filter((d) => !EXCLUDED_TYPES.includes(d.type))
    .map((d) => ({
      type: d.type,
      label: d.label,
      roles: d.roles.map((r) => ({
        id: r.id,
        label: r.label,
        kind: r.kind,
        max: r.max ?? null,
        required: r.required ?? false,
        types: r.types ?? null,
      })),
      options: d.options
        .filter((o) => !EXCLUDED_OPTIONS.has(o.key))
        .map((o) => ({ key: o.key, type: o.type, choices: o.choices?.map((c) => c.value) ?? null })),
    }));
}
