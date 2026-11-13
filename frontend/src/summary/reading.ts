/**
 * Lecture calculée d'une page : une phrase d'ouverture puis quelques constats, écrits ici à partir des
 * résultats déjà affichés (aucune IA). Elle sert deux fois :
 * - de point d'appui pour l'IA, qui la reformule et relie les constats entre eux ;
 * - de repli : quand le modèle échoue ou que ses phrases sont écartées, c'est elle qui s'affiche.
 *
 * Chaque constat compare, situe ou décrit une évolution (jamais « Libellé : valeur » recopié d'une carte),
 * et ses nombres restent lisibles par `numbers()` côté backend, qui les vérifie comme les autres faits.
 */

import type { Page, Visual } from "../types/report";
import type { ReadingPoint, SummaryReading } from "../types/summary";
import { formatNumber } from "../visuals/format";
import { type Single, type VisualAnalysis, percent, quoted } from "./facts";

/** Nombre de constats envoyés au plus (le backend n'en garde que `max_points`). */
export const MAX_READING_POINTS = 6;

interface Item {
  visual: Visual;
  title: string;
  analysis: VisualAnalysis;
}

interface Weighted extends ReadingPoint {
  weight: number;
}

type Card = Single & { id: string };

/**
 * Rapport entre les cartes de la page : les sommes d'une même unité rapportées à la plus grande
 * (« Dépenses » représente 70 % de « Recettes »).
 */
function ratioPoints(cards: Card[]): Weighted[] {
  const out: Weighted[] = [];
  const byUnit = new Map<string, Card[]>();
  for (const c of cards) {
    if (c.agg !== "sum" || !(c.value > 0)) continue;
    byUnit.set(c.unit, [...(byUnit.get(c.unit) ?? []), c]);
  }
  for (const group of byUnit.values()) {
    const sorted = [...group].sort((a, b) => b.value - a.value);
    const base = sorted[0];
    const others = sorted.slice(1, 3).filter((c) => base && c.value < base.value);
    if (!base || !others.length) continue;
    const [a, b] = others as [Card, Card | undefined];
    let text = `${quoted(a.label)} (${a.text}) représente ${percent(a.value / base.value)} de ${quoted(base.label)} (${base.text})`;
    if (b) text += ` ; ${quoted(b.label)} (${b.text}) en représente ${percent(b.value / base.value)}`;
    out.push({ text: `${text}.`, visuals: [a.id, base.id, ...(b ? [b.id] : [])], weight: 4 });
  }
  return out;
}

/** Écart entre le maximum et la moyenne d'un même champ (« le maximum vaut 1,6 fois la moyenne »). */
function spreadPoints(cards: Card[]): Weighted[] {
  const out: Weighted[] = [];
  for (const max of cards.filter((c) => c.agg === "max")) {
    const avg = cards.find((c) => c.agg === "avg" && c.field === max.field && c.unit === max.unit);
    if (!avg || !(avg.value > 0) || max.value / avg.value < 1.2) continue;
    const times = formatNumber(Math.round((max.value / avg.value) * 10) / 10, { decimals: 1 });
    out.push({ text: `${quoted(max.label)} (${max.text}) vaut ${times} fois ${quoted(avg.label)} (${avg.text}).`, visuals: [max.id, avg.id], weight: 1.8 });
  }
  return out;
}

/** Ouverture : la page, sa période, ses filtres, et ses trois premiers chiffres clés en une phrase. */
function opening(page: Page, period: string | undefined, filters: string[], cards: Card[], lead: Weighted | undefined): string {
  const name = page.name || "Page";
  const scope = filters.length ? ` (filtré : ${filters.slice(0, 2).join(" ; ")}${filters.length > 2 ? "…" : ""})` : "";
  const head = `${name}${period ? `, ${period}` : ""}${scope}`;
  if (cards.length) {
    const same = (c: Card) => c.label.trim().toLowerCase() === name.trim().toLowerCase();
    return `${head} : ${cards.slice(0, 3).map((c) => (same(c) ? `${c.text} en tout` : `${c.label} ${c.text}`)).join(", ")}.`;
  }
  return lead ? `${head} : ${lead.text}` : `${head}.`;
}

/**
 * Lecture calculée de la page : ouverture, puis les constats les plus lourds, un par visuel au plus,
 * chacun relié à ses visuels. Renvoie null quand la page n'offre aucun constat (rien à comparer).
 */
export function pageReading(page: Page, items: Item[], filters: string[] = []): SummaryReading | null {
  const cards: Card[] = items.flatMap((it) => (it.analysis.single ? [{ ...it.analysis.single, id: it.visual.id }] : []));
  const period = items.find((it) => it.analysis.period)?.analysis.period;
  const points: Weighted[] = [...ratioPoints(cards), ...spreadPoints(cards)];
  for (const it of items) {
    const note = [...it.analysis.notes].sort((a, b) => b.weight - a.weight)[0];
    if (note) points.push({ text: note.text, visuals: [it.visual.id], weight: note.weight });
  }
  points.sort((a, b) => b.weight - a.weight);
  if (!points.length) return null;
  // Sans carte, le constat le plus lourd fait l'ouverture : il ne se répète pas dans les points.
  const lead = !cards.length && points.length > 1 ? points[0] : undefined;
  const kept = (lead ? points.slice(1) : points).slice(0, MAX_READING_POINTS);
  return {
    headline: opening(page, period, filters, cards, lead).slice(0, 300),
    period: period ?? null,
    points: kept.map(({ text, visuals }) => ({ text: text.slice(0, 400), visuals: [...new Set(visuals)].slice(0, 6) })),
  };
}
