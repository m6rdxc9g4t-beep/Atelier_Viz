/**
 * Rapports générés à partir des profils des jeux de données (sans IA), à la manière d'un rapport Power BI :
 * barre de filtres à gauche (segments adaptés au jeu), titre et navigateur de pages en haut, KPI puis graphiques.
 *
 * Le contenu dépend de la nature du jeu, reconnue sur les noms, types et valeurs des colonnes (`analyze`) :
 * - « flux » : opérations avec débit / crédit ou montant signé → recettes, dépenses, solde, catégories ;
 * - « événements » : lignes datées nombreuses (commandes, caisse, campagnes…) → évolution, répartitions ;
 * - « liste » : quelques dizaines d'éléments nommés (contrats, lots, missions…) → classement, statuts, avancement.
 * Jamais de secteurs sur des valeurs négatives ni de légende qui répète l'axe.
 */

import type { ColumnProfile, DatasetProfile } from "../types/dataset";
import type { Filter } from "../types/query";
import type { FieldBinding, Layout, Page, Visual, VisualOptions, VisualType } from "../types/report";
import { navigatorWidth, rangeSlicerMinHeight, textWidth } from "../visuals/fit";
import { normalize } from "../visuals/maps/geo";
import { uid } from "./uid";

// ─── Analyse des colonnes ────────────────────────────────────────────────────────────────────────────────

const GEO_HINTS: Record<string, string> = {
  region: "fr-regions",
  departement: "fr-departements",
  dept: "fr-departements",
  pays: "world",
  country: "world",
};

const has = (c: ColumnProfile, re: RegExp) => re.test(normalize(c.name));

const MONEY = /\bcpa\b|\bcpc\b|\bcpm\b|montant|debit|credit|prime|cout|loyer|charges|budget|chiffre|\bca\b|ttc|\bht\b|depense|tjm|valeur|prix|vente|revenu|recette|solde|tresorerie|sinistres? 20|amount|sales|price|cost/;
const DEBIT = /\bdebit\b|\bdepenses?\b|\bsorties?\b|decaisse/;
const CREDIT = /\bcredit\b|\brecettes?\b|\bentrees?\b|encaisse/;
const PERCENT = /avancement|\btaux\b|pourcent|\bpart\b|ratio|marge|%|progression|completion/;
/** Noms de parts d'un tout (allocation cible / réelle, poids). */
const SHARE_NAME = /cible|reel|poids|allocation|repartition|\bpart\b/;
const STATUS = /statut|status|situation|\betat\b|renouvellement|stade|phase|priorite/;
const PERSON = /responsable|client|locataire|assureur|fournisseur|commercial|vendeur|proprietaire|auteur|owner|canal|regie/;
/** Prix unitaires, tarifs, taux : à moyenner, jamais à additionner. */
const UNIT = /prix|unitaire|\btjm\b|tarif|price|\btaux\b|cours|satisfaction|note\b|score|\bcpa\b|\bcpc\b|\bcpm\b|moyen/;
/** Montants qui s'additionnent (chiffre d'affaires, coûts…), préférés comme mesure principale. */
const TOTAL = /chiffre|\bca\b|montant|ventes?|revenu|recette|total|amount|sales|ttc|\bht\b|prime|cout|depense|budget|loyer|valeur|sinistres? 20/;
const IGNORE_NUM = /^(id|code|lat|lon|lng|latitude|longitude|annee|year|numero|n )/;
const PERIOD_VALUE = /^\d{4}-(0[1-9]|1[0-2])$|^\d{4}-?[qt][1-4]$/i;

export type DatasetKind = "flows" | "events" | "list";

export interface Analysis {
  ds: DatasetProfile;
  kind: DatasetKind;
  /** Nom court (sans extension ni préfixe d'histoire). */
  label: string;
  date?: ColumnProfile;
  /** Colonne texte de périodes (« 2026-08 »). */
  period?: ColumnProfile;
  debit?: ColumnProfile;
  credit?: ColumnProfile;
  /** Montant signé (négatif = dépense). */
  signed?: ColumnProfile;
  /** Mesure principale (positive de préférence). */
  main?: ColumnProfile;
  /** Autres mesures (quantités, montants secondaires). */
  others: ColumnProfile[];
  percent?: ColumnProfile;
  /** Parts qui totalisent 100 % sur le jeu (allocation cible / réelle) : à comparer, jamais à moyenner. */
  shares: ColumnProfile[];
  status?: ColumnProfile;
  /** Colonne qui nomme chaque ligne (lot, contrat, commande…). */
  name?: ColumnProfile;
  /** Dimensions de regroupement, de la plus utile à la moins utile. */
  dims: ColumnProfile[];
  geo?: ColumnProfile;
  lat?: ColumnProfile;
  lon?: ColumnProfile;
}

const isNum = (c: ColumnProfile) => c.type === "number";
const isText = (c: ColumnProfile) => c.type === "string";
const numMin = (c: ColumnProfile | undefined) => (typeof c?.min === "number" ? c.min : null);
const numMax = (c: ColumnProfile | undefined) => (typeof c?.max === "number" ? c.max : null);

/** Nom lisible d'un jeu : « Rénovation Urbaine 2026 — Planning & Lots » → « Planning & Lots ». */
export function shortName(name: string): string {
  const base = name.replace(/\.(csv|xlsx?|json|parquet)$/i, "");
  const parts = base.split(" — ");
  const last = parts[parts.length - 1] ?? base;
  return /opérations/i.test(last) ? "Opérations" : last;
}

/** Reconnaît la nature d'un jeu et le rôle de ses colonnes. */
export function analyze(ds: DatasetProfile): Analysis {
  const cols = ds.columns.filter((c) => !c.measure);
  const nums = cols.filter((c) => isNum(c) && !has(c, IGNORE_NUM) && !c.related);
  const texts = cols.filter(isText);
  const date = cols.find((c) => c.type === "date" && /^date$|^jour$|^day$/.test(normalize(c.name))) ?? cols.find((c) => c.type === "date");
  const period = texts.find((c) => c.distinct >= 2 && c.distinct <= 60 && c.top_values.length > 0 && c.top_values.every((v) => PERIOD_VALUE.test(String(v.value))));

  const debit = nums.find((c) => has(c, DEBIT));
  const credit = nums.find((c) => has(c, CREDIT));
  const signed = nums.find((c) => c !== debit && c !== credit && has(c, /montant|solde|amount|net/) && (numMin(c) ?? 0) < 0);
  const pctLike = (c: ColumnProfile) => (has(c, PERCENT) && (numMax(c) ?? 0) <= 100 && (numMin(c) ?? 0) >= 0) || isFraction(c);
  // Parts d'un tout : des fractions (ou des pourcentages) qui totalisent 1 (ou 100) sur le jeu.
  const shares = nums.filter(
    (c) =>
      (isFraction(c) || (has(c, SHARE_NAME) && (numMax(c) ?? 101) <= 100 && (numMin(c) ?? -1) >= 0)) &&
      c.mean !== null &&
      (Math.abs(c.mean * ds.rows - 1) < 0.05 || Math.abs(c.mean * ds.rows - 100) < 5),
  );
  const percent = nums.find((c) => pctLike(c) && !shares.includes(c));
  const money = nums.filter((c) => c !== percent && has(c, MONEY));
  const positive = (c: ColumnProfile) => (numMin(c) ?? 0) >= 0;
  const plain = (c: ColumnProfile) => c !== debit && c !== credit && c !== signed && !pctLike(c) && !has(c, UNIT);
  const main =
    (debit && credit ? credit : undefined) ??
    nums.find((c) => plain(c) && positive(c) && has(c, TOTAL)) ??
    money.find((c) => plain(c) && positive(c)) ??
    nums.find((c) => plain(c) && positive(c)) ??
    signed ??
    money[0] ??
    nums[0];
  const lat = cols.find((c) => isNum(c) && /^(lat|latitude)$/.test(normalize(c.name)));
  const lon = cols.find((c) => isNum(c) && /^(lon|lng|long|longitude)$/.test(normalize(c.name)));
  const others = nums.filter((c) => c !== main && c !== percent && c !== signed && c !== debit && c !== credit && !pctLike(c));

  const status = texts.find((c) => has(c, STATUS) && c.distinct >= 2 && c.distinct <= 10);
  const name = texts.find((c) => c !== period && c.distinct >= Math.max(2, ds.rows * 0.9) && ds.rows <= 80);
  const geo = texts.find((c) => GEO_HINTS[normalize(c.name)]);
  // Regroupements utiles : ni libellés quasi uniques (« Libellé » d'une opération), ni trop de valeurs.
  const dims = texts
    .filter((c) => c !== period && c !== name && !has(c, /libelle|label|description|intitule|objet|commentaire|reference|\bref\b/))
    .filter((c) => c.distinct >= 2 && c.distinct <= 40 && (ds.rows <= 12 ? c.distinct < ds.rows : c.distinct <= ds.rows * 0.6))
    .sort((a, b) => score(b) - score(a));

  const kind: DatasetKind = (debit && credit) || signed ? "flows" : date && ds.rows > 40 ? "events" : "list";
  return { ds, kind, label: shortName(ds.name), date, period, debit, credit, signed, main, others, percent, shares, status, name, dims, geo, lat, lon };
}

/** Intérêt d'une dimension pour un regroupement : catégorie > statut > personne, peu de valeurs distinctes. */
function score(c: ColumnProfile): number {
  let s = c.related ? -3 : 0;
  if (has(c, /categorie|category|type|branche|rayon|famille|nature|canal|segment|classe|produit|lot/)) s += 4;
  if (has(c, STATUS)) s += 2;
  if (has(c, PERSON)) s += 1;
  if (c.distinct <= 12) s += 2;
  return s - c.distinct / 40;
}

/** Fraction entre 0 et 1 nommée comme une part ou un taux (0,6 = 60 %). */
function isFraction(c: ColumnProfile | undefined): boolean {
  return !!c && c.type === "number" && (numMin(c) ?? -1) >= 0 && (numMax(c) ?? 2) <= 1 && (has(c, PERCENT) || has(c, SHARE_NAME));
}

// ─── Construction des visuels ───────────────────────────────────────────────────────────────────────────

const isMoney = (c: ColumnProfile | undefined) => !!c && has(c, MONEY) && !isFraction(c);

/** « Montant TTC » → « montant TTC » (garde les sigles). */
const lower = (name: string) => (/^[A-ZÀ-Ý][a-zà-ÿ]/.test(name) ? name[0]!.toLowerCase() + name.slice(1) : name);

/** Libellés trop longs pour un axe (récits, descriptions) : mieux dans une table. */
const longValues = (c: ColumnProfile | undefined) =>
  !!c && c.top_values.length > 0 && c.top_values.reduce((n, v) => n + String(v.value).length, 0) / c.top_values.length > 26;

/** Format d'une mesure : euros pour un montant, % pour un taux, notation compacte sinon. */
function numberOptions(c: ColumnProfile | undefined, agg: FieldBinding["agg"] = "sum"): VisualOptions {
  if (!c || agg === "count" || agg === "count_distinct") return { compact: true };
  if (isFraction(c)) return { fraction: true, decimals: 0 };
  if (c && has(c, PERCENT) && (numMax(c) ?? 0) <= 100) return { decimals: 0, suffix: " %" };
  return isMoney(c) ? { compact: true, suffix: " €" } : { compact: true };
}

function visual(
  type: VisualType,
  dataset: string,
  layout: Layout,
  roles: Visual["roles"],
  options: VisualOptions = {},
  title: string | null = null,
  filters: Filter[] = [],
): Visual {
  return { id: uid(), type, title, layout, dataset_id: dataset, roles, options, filters };
}

const measure = (c: ColumnProfile, agg: FieldBinding["agg"] = "sum", label?: string): FieldBinding => ({ field: c.name, agg, ...(label ? { label } : {}) });
/** Agrégation naturelle d'une mesure : moyenne pour un prix ou un taux, somme sinon. */
const averaged = (c: ColumnProfile) => has(c, UNIT) || has(c, PERCENT) || isFraction(c);
const natural = (c: ColumnProfile, label?: string): FieldBinding => measure(c, averaged(c) ? "avg" : "sum", label ?? c.name);
const kpiTitle = (c: ColumnProfile) => (averaged(c) ? `${c.name} (moyenne)` : `Total ${lower(c.name)}`);
const dim = (c: ColumnProfile, bin?: FieldBinding["bin"]): FieldBinding => ({ field: c.name, ...(bin ? { bin } : {}) });
const positiveOnly = (c: ColumnProfile): Filter[] => [{ field: c.name, op: "gt", values: [0] }];

/** Pas de temps lisible pour la période couverte par la colonne date. */
function timeBin(a: Analysis): FieldBinding["bin"] {
  const lo = typeof a.date?.min === "string" ? Date.parse(a.date.min) : NaN;
  const hi = typeof a.date?.max === "string" ? Date.parse(a.date.max) : NaN;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return "month";
  const days = (hi - lo) / 86_400_000;
  return days > 1100 ? "quarter" : days > 120 ? "month" : days > 35 ? "week" : "day";
}

/** Axe du temps : la date regroupée, sinon la colonne de périodes. */
function timeAxis(a: Analysis): FieldBinding | null {
  if (a.date) return dim(a.date, timeBin(a));
  if (a.period) return dim(a.period);
  return null;
}

/** Répartition : secteurs si peu de parts et toutes positives, barres sinon. */
function share(a: Analysis, rect: Layout, by: ColumnProfile, m: FieldBinding, title: string, filters: Filter[] = []): Visual {
  const col = a.ds.columns.find((c) => c.name === m.field);
  const allPositive = m.agg === "count" || (numMin(col) ?? 0) >= 0 || filters.length > 0;
  if (allPositive && by.distinct <= 6) {
    return visual("donut", a.ds.id, rect, { category: [dim(by)], values: [m] }, { ...numberOptions(col, m.agg), legend: true }, title, filters);
  }
  return visual("bar", a.ds.id, rect, { category: [dim(by)], values: [m] }, { ...numberOptions(col, m.agg), sort: "value_desc", labels: true, topN: 10 }, title, filters);
}

// ─── Mise en page (px d'une page 1280 × 720) ────────────────────────────────────────────────────────────

const PAGE = { width: 1280, height: 720 };
const SIDE = { x: 0, w: 232 };
const X0 = 248;
const X1 = 1272;
const GAP = 12;
/** Largeur gardée au titre de la page, à gauche du navigateur, et taille de son texte (`size: "lg"`). */
const TITLE_MIN = 300;
const TITLE_FONT = 18;
/** Largeur en dessous de laquelle un onglet du navigateur ne descend pas, même face à un titre très long. */
const NAV_TAB_MIN = 96;
// Rangée des KPI : assez haute pour un titre, la valeur et une mini-tendance (`kpiMinHeight`).
const ROWS = { kpi: { y: 60, h: 116 }, mid: { y: 188, h: 254 }, low: { y: 454, h: 258 }, full: { y: 188, h: 524 } };

/** Découpe la largeur de contenu en colonnes (fractions de 12). */
function cols(y: number, h: number, spans: number[]): Layout[] {
  const total = spans.reduce((s, n) => s + n, 0);
  const width = X1 - X0 - GAP * (spans.length - 1);
  let x = X0;
  return spans.map((n) => {
    const w = Math.round((width * n) / total);
    const r = { x, y, w, h };
    x += w + GAP;
    return r;
  });
}

/** Barre de filtres : panneau, segments choisis pour le jeu, bouton de réinitialisation. */
function sidebar(a: Analysis): Visual[] {
  const out: Visual[] = [visual("text", "", { x: SIDE.x + 8, y: 8, w: SIDE.w - 16, h: PAGE.height - 16 }, {}, { text: "**Filtres**", size: "md", panel: true })];
  const x = SIDE.x + 16;
  const w = SIDE.w - 32;
  let y = 44;
  const add = (field: ColumnProfile, style: "range" | "dropdown" | "tiles" | "list", h: number) => {
    if (y + h > PAGE.height - 72) return;
    out.push(visual("slicer", a.ds.id, { x, y, w, h }, { field: [dim(field)] }, { style, multi: style !== "range", search: false }, field.name));
    y += h + 8;
  };
  // Plage de dates : dans cette colonne étroite, les deux champs passent l'un sous l'autre (année entière visible).
  if (a.date) add(a.date, "range", rangeSlicerMinHeight(w));
  if (a.period) add(a.period, "tiles", 56 + Math.ceil(a.period.distinct / 2) * 34);
  // Segments : statut puis regroupements du jeu lui-même (les colonnes d'un jeu lié seulement à défaut).
  const own = [a.status, ...a.dims].filter((c, i, all): c is ColumnProfile => !!c && all.indexOf(c) === i && c !== a.name);
  const picks = own.some((c) => !c.related) ? own.filter((c) => !c.related) : own;
  // Rien à regrouper (petite liste) : on filtre sur les éléments eux-mêmes.
  const chosen = picks.length ? picks : a.name && a.name.distinct <= 12 ? [a.name] : [];
  for (const c of chosen.slice(0, 4)) {
    if (c.distinct <= 6) add(c, "list", 48 + c.distinct * 26);
    else add(c, "dropdown", 76);
  }
  out.push(visual("button", "", { x, y: PAGE.height - 60, w, h: 40 }, {}, { label: "Réinitialiser", action: "reset", variant: "secondary" }));
  return out;
}

/** En-tête : titre de la page à gauche, jusqu'au navigateur de pages (ajouté par `finish`). */
function header(title: string, subtitle: string, right: number): Visual {
  const text = subtitle && subtitle !== title ? `**${title}** — ${subtitle}` : `**${title}**`;
  return visual("text", "", { x: X0, y: 8, w: right - X0, h: 44 }, {}, { text, size: "lg" });
}

interface Section {
  name: string;
  /** Visuels du contenu (hors barre de filtres, titre et navigateur). */
  visuals: Visual[];
  analysis: Analysis;
}

/** Assemble les pages : barre de filtres, titre, navigateur (horizontal) sur chaque page. */
function finish(sections: Section[], title: string): Page[] {
  const pages: Page[] = sections.map((s) => ({ id: uid(), name: s.name, size: { ...PAGE }, filters: [], visuals: [] }));
  // Navigateur : la largeur des noms de pages (aucun onglet abrégé), tant que le titre le plus long tient sur sa ligne.
  const names = sections.map((s) => s.name);
  const navNeed = navigatorWidth(names);
  const boldW = textWidth(title, TITLE_FONT, true);
  const fullW = Math.ceil(boldW + Math.max(0, ...names.map((n) => (n === title ? 0 : textWidth(` — ${n}`, TITLE_FONT))))) + 24;
  const room = (titleW: number) => X1 - X0 - GAP - Math.max(TITLE_MIN, titleW);
  // Titre et navigateur ne tiennent pas côte à côte : le titre perd le nom de la page (l'onglet courant le
  // porte déjà) plutôt que d'abréger tous les onglets — sur toutes les pages, pour que rien ne bouge de l'une à l'autre.
  const named = sections.length <= 1 || navNeed <= room(fullW);
  const navMax = room(named ? fullW : Math.ceil(boldW) + 24);
  const navW = sections.length > 1 ? Math.min(navNeed + 8 * names.length, Math.max(navMax, NAV_TAB_MIN * names.length)) : 0;
  const titleRight = navW ? X1 - navW - GAP : X1;
  sections.forEach((s, i) => {
    const page = pages[i];
    if (!page) return;
    page.visuals = [
      ...sidebar(s.analysis),
      header(title, named ? s.name : "", titleRight),
      ...(sections.length > 1 ? [visual("navigator", "", { x: X1 - navW, y: 8, w: navW, h: 44 }, {}, { orientation: "horizontal", look: "tabs" })] : []),
      ...s.visuals,
    ];
  });
  return pages;
}

// ─── Recettes par nature de jeu ─────────────────────────────────────────────────────────────────────────

function kpis(a: Analysis, items: { m: FieldBinding; col?: ColumnProfile; title: string; trend?: boolean; extra?: VisualOptions }[]): Visual[] {
  const rects = cols(ROWS.kpi.y, ROWS.kpi.h, items.map(() => 1));
  const axis = a.date ? dim(a.date, "month") : null;
  return items.map((k, i) =>
    visual(
      "kpi",
      a.ds.id,
      rects[i] ?? rects[0]!,
      { values: [k.m], ...(k.trend && axis ? { trend: [axis] } : {}) },
      { ...numberOptions(k.col, k.m.agg), ...k.extra },
      k.title,
    ),
  );
}

/** Opérations (débit / crédit ou montant signé) : trésorerie, dépenses par catégorie, liste des opérations. */
function flowSections(a: Analysis): Section[] {
  const id = a.ds.id;
  const axis = a.period ? dim(a.period) : a.date ? dim(a.date, "month") : null;
  const cat = a.dims[0];
  const out: Section[] = [];
  const debit = a.debit;
  const credit = a.credit;
  const net = a.signed;

  const k: Parameters<typeof kpis>[1] = [];
  if (credit) k.push({ m: measure(credit, "sum", "Recettes"), col: credit, title: "Recettes" });
  if (debit) k.push({ m: measure(debit, "sum", "Dépenses"), col: debit, title: "Dépenses", extra: { higherIsBetter: false } });
  if (net) k.push({ m: measure(net, "sum", "Solde de la période"), col: net, title: "Solde de la période", trend: true });
  k.push({ m: { field: (net ?? debit ?? credit ?? a.main)?.name ?? "", agg: "count", label: "Opérations" }, title: "Opérations" });
  const overview: Visual[] = kpis(a, k.filter((x) => x.m.field));

  const [left, right] = cols(ROWS.mid.y, ROWS.mid.h, [7, 5]);
  if (axis && left && (credit || debit)) {
    const values = [credit && measure(credit, "sum", "Recettes"), debit && measure(debit, "sum", "Dépenses")].filter((x): x is FieldBinding => !!x);
    overview.push(visual("column", id, left, { category: [axis], values }, { compact: true, suffix: " €", legend: true }, "Recettes et dépenses par mois"));
  } else if (axis && left && net) {
    overview.push(visual("column", id, left, { category: [axis], values: [measure(net, "sum", "Solde")] }, { compact: true, suffix: " €" }, "Solde par mois"));
  }
  if (a.date && net && right) {
    overview.push(
      visual("area", id, right, { category: [dim(a.date, "week")], values: [{ ...measure(net, "sum", "Solde cumulé"), show: { kind: "running", date: a.date.name } }] }, { compact: true, suffix: " €", smooth: false }, "Solde cumulé"),
    );
  } else if (cat && right && debit) {
    overview.push(share(a, right, cat, measure(debit, "sum", "Dépenses"), "Part des dépenses", positiveOnly(debit)));
  }
  const [low1, low2] = cols(ROWS.low.y, ROWS.low.h, [7, 5]);
  if (cat && low1 && debit) {
    overview.push(visual("bar", id, low1, { category: [dim(cat)], values: [measure(debit, "sum", "Dépenses")] }, { compact: true, suffix: " €", sort: "value_desc", labels: true, topN: 10 }, `Dépenses par ${lower(cat.name)}`, positiveOnly(debit)));
  } else if (cat && low1 && net) {
    overview.push(visual("waterfall", id, low1, { category: [dim(cat)], values: [measure(net, "sum", "Montant")] }, { compact: true, suffix: " €" }, `Contribution au solde par ${lower(cat.name)}`));
  }
  if (cat && low2 && credit) {
    overview.push(share(a, low2, cat, measure(credit, "sum", "Recettes"), `Recettes par ${lower(cat.name)}`, positiveOnly(credit)));
  }
  out.push({ name: "Trésorerie", visuals: overview, analysis: a });

  // Analyse des dépenses : catégorie × période, poids de chaque poste.
  if (cat && (debit || net)) {
    const spend = debit ? measure(debit, "sum", "Dépenses") : measure(net!, "sum", "Montant");
    const [m1, m2] = cols(ROWS.kpi.y, ROWS.full.h + ROWS.kpi.h + GAP, [7, 5]);
    const page: Visual[] = [];
    const period = a.period ? dim(a.period) : a.date ? dim(a.date, "month") : null;
    const only = debit ? positiveOnly(debit) : [];
    if (m1) {
      const half = Math.round((m1.h - GAP) / 2);
      page.push(visual("matrix", id, { ...m1, h: half }, { rows: [dim(cat)], ...(period ? { columns: [period] } : {}), values: [spend] }, { compact: true, suffix: " €", conditional: { [`sum(${spend.field})`]: { scale: "sequential" } } }, `Dépenses par ${lower(cat.name)} et par mois`, only));
      if (period) {
        page.push(visual("column", id, { ...m1, y: m1.y + half + GAP, h: m1.h - half - GAP }, { category: [period], series: [dim(cat)], values: [spend] }, { stacked: true, compact: true, suffix: " €", legend: true }, "Composition des dépenses par mois", only));
      }
    }
    if (m2) {
      page.push(visual("treemap", id, m2, { category: [dim(cat)], values: [spend] }, { compact: true, suffix: " €" }, "Poids de chaque poste", debit ? positiveOnly(debit) : []));
    }
    out.push({ name: "Dépenses", visuals: page, analysis: a });
  }

  // Liste des opérations.
  const label = a.ds.columns.find((c) => isText(c) && has(c, /libelle|label|description|intitule|objet/));
  const columns = [a.date && dim(a.date, "day"), label && dim(label), cat && dim(cat)].filter((x): x is FieldBinding => !!x);
  const values = [debit && measure(debit, "sum", debit.name), credit && measure(credit, "sum", credit.name), !debit && !credit && net ? measure(net, "sum", net.name) : null].filter((x): x is FieldBinding => !!x);
  if (columns.length) {
    const table = visual("table", id, { x: X0, y: ROWS.kpi.y, w: X1 - X0, h: PAGE.height - ROWS.kpi.y - 8 }, { columns, values }, { compact: false, decimals: 2, suffix: " €", sort: "category", totals: true, conditional: Object.fromEntries(values.map((v) => [`sum(${v.field})`, { bars: true }])) }, "Opérations");
    out.push({ name: "Opérations", visuals: [table], analysis: a });
  }
  return out;
}

/** Lignes datées nombreuses (commandes, caisse, régies…) : évolution, répartitions, détail. */
function eventSections(a: Analysis): Section[] {
  const id = a.ds.id;
  const main = a.main;
  const axis = timeAxis(a);
  const [d1, d2] = a.dims;
  const out: Section[] = [];
  const visuals: Visual[] = [];
  const quantity = a.others.find((c) => !isMoney(c));
  const second = a.others.find((c) => c !== quantity);

  const k: Parameters<typeof kpis>[1] = [];
  if (main) {
    k.push({ m: measure(main, "sum", `${main.name}`), col: main, title: `Total ${lower(main.name)}`, trend: true });
    k.push({ m: measure(main, "avg", `${main.name} (moyenne)`), col: main, title: `${main.name} (moyenne)` });
  }
  if (quantity) k.push({ m: natural(quantity), col: quantity, title: kpiTitle(quantity) });
  else if (second) k.push({ m: natural(second), col: second, title: kpiTitle(second) });
  k.push({ m: { field: (main ?? a.ds.columns[0])?.name ?? "", agg: "count", label: "Lignes" }, title: "Nombre de lignes" });
  visuals.push(...kpis(a, k.slice(0, 4)));

  const [left, right] = cols(ROWS.mid.y, ROWS.mid.h, [8, 4]);
  if (main && axis && left) {
    visuals.push(visual("line", id, left, { category: [axis], ...(d1 && d1.distinct <= 6 ? { series: [dim(d1)] } : {}), values: [measure(main, "sum", main.name)] }, { ...numberOptions(main), markers: true, legend: true }, `${main.name} dans le temps${d1 && d1.distinct <= 6 ? ` par ${lower(d1.name)}` : ""}`));
  }
  if (main && d1 && right) visuals.push(share(a, right, d1, measure(main, "sum", main.name), `Répartition par ${lower(d1.name)}`));
  const [low1, low2] = cols(ROWS.low.y, ROWS.low.h, [6, 6]);
  if (main && low1 && (d2 ?? d1)) {
    const by = (d2 ?? d1)!;
    visuals.push(visual("bar", id, low1, { category: [dim(by)], values: [measure(main, "sum", main.name)] }, { ...numberOptions(main), sort: "value_desc", labels: true, topN: 10 }, `${main.name} par ${lower(by.name)}`));
  }
  if (low2 && d1 && (quantity ?? second)) {
    const q = (quantity ?? second)!;
    visuals.push(visual("column", id, low2, { category: [dim(d1)], values: [natural(q)] }, { ...numberOptions(q), sort: "value_desc", labels: true }, `${q.name} par ${lower(d1.name)}`));
  } else if (low2 && main && a.geo) {
    visuals.push(visual("map", id, low2, { location: [dim(a.geo)], values: [measure(main, "sum", main.name)] }, { geo: GEO_HINTS[normalize(a.geo.name)], compact: true }, `${main.name} par ${lower(a.geo.name)}`));
  } else if (low2 && main && axis) {
    visuals.push(visual("column", id, low2, { category: [axis], values: [{ ...measure(main, "sum", "Cumul"), show: { kind: "running", date: a.date?.name ?? null } }] }, numberOptions(main), "Cumul sur la période"));
  }
  out.push({ name: a.label === "Opérations" ? "Vue d'ensemble" : a.label, visuals, analysis: a });

  // Analyse : tableau croisé par mois, carte ou cumul, meilleurs éléments.
  if (main) {
    const page: Visual[] = [];
    const rows = [d1, d2].filter((c): c is ColumnProfile => !!c).map((c) => dim(c));
    const period = a.date ? dim(a.date, "month") : a.period ? dim(a.period) : null;
    if (rows.length) {
      page.push(
        visual("matrix", id, { x: X0, y: ROWS.kpi.y, w: X1 - X0, h: 300 }, { rows, ...(period ? { columns: [period] } : {}), values: [measure(main, "sum", main.name)] }, { ...numberOptions(main), conditional: { [`sum(${main.name})`]: { scale: "sequential" } } }, `${main.name} par ${lower(rows[0]!.field)}${period ? " et par mois" : ""}`),
      );
    }
    const y = rows.length ? ROWS.kpi.y + 300 + GAP : ROWS.kpi.y;
    const [b1, b2] = cols(y, PAGE.height - 8 - y, [6, 6]);
    let mapped: ColumnProfile | undefined;
    if (b1 && a.lat && a.lon) {
      page.push(visual("pointmap", id, b1, { lat: [dim(a.lat)], lon: [dim(a.lon)], size: [measure(main, "sum", main.name)] }, { basemap: "france" }, `${main.name} sur la carte`));
    } else if (b1 && a.geo) {
      mapped = a.geo;
      page.push(visual("map", id, b1, { location: [dim(a.geo)], values: [measure(main, "sum", main.name)] }, { geo: GEO_HINTS[normalize(a.geo.name)], compact: true }, `${main.name} par ${lower(a.geo.name)}`));
    } else if (b1 && period) {
      page.push(visual("column", id, b1, { category: [period], values: [{ ...measure(main, "sum", "Cumul"), show: { kind: "running", date: a.date?.name ?? null } }] }, numberOptions(main), `${main.name} cumulé`));
    }
    const top = a.name ?? a.ds.columns.find((c) => isText(c) && !c.related && c.distinct > 6 && c !== d1 && c !== d2 && c !== a.period);
    if (b2 && top) {
      page.push(visual("table", id, b2, { columns: [dim(top)], values: [measure(main, "sum", main.name), ...(quantity ? [natural(quantity)] : [])] }, { ...numberOptions(main), sort: "value_desc", topN: 15, totals: false, conditional: { [`sum(${main.name})`]: { bars: true } } }, `Top 15 — ${lower(top.name)}`));
    } else if (b2 && d2 && d2 !== mapped) {
      page.push(visual("bar", id, b2, { category: [dim(d2)], values: [measure(main, "sum", main.name)] }, { ...numberOptions(main), sort: "value_desc", labels: true, topN: 10 }, `${main.name} par ${lower(d2.name)}`));
    } else if (b2 && mapped && period) {
      page.push(visual("column", id, b2, { category: [period], values: [{ ...measure(main, "sum", "Cumul"), show: { kind: "running", date: a.date?.name ?? null } }] }, numberOptions(main), `${main.name} cumulé`));
    }
    if (page.length) out.push({ name: "Analyse", visuals: page, analysis: a });
  }
  return out;
}

/** Quelques dizaines d'éléments nommés (contrats, lots, missions, factures…) : une page de pilotage. */
function listSections(a: Analysis): Section[] {
  const id = a.ds.id;
  const main = a.main;
  // Axe du classement : le nom de chaque élément, sauf s'il est trop long (récit…) → une catégorie.
  const named = a.name ?? a.dims[0];
  const by = longValues(named) ? (a.dims.find((c) => c !== a.status) ?? named) : named;
  const group = a.dims.find((c) => c !== a.status && c !== by) ?? a.dims.find((c) => c !== by);
  const visuals: Visual[] = [];

  const k: Parameters<typeof kpis>[1] = [{ m: { field: (by ?? main ?? a.ds.columns[0])?.name ?? "", agg: "count", label: a.label }, title: a.label }];
  if (main) k.push({ m: measure(main, "sum", main.name), col: main, title: `Total ${lower(main.name)}` });
  if (a.percent) k.push({ m: measure(a.percent, "avg", `${a.percent.name} moyen`), col: a.percent, title: `${a.percent.name} moyen` });
  const second = a.others.find((c) => c !== main);
  if (second) k.push({ m: natural(second), col: second, title: kpiTitle(second) });
  if (k.length < 4 && main) k.push({ m: measure(main, "avg", `${main.name} (moyenne)`), col: main, title: `${main.name} (moyenne)` });
  if (k.length < 4 && main) k.push({ m: measure(main, "max", `${main.name} (maximum)`), col: main, title: `${main.name} (maximum)` });
  visuals.push(...kpis(a, k.slice(0, 4)));

  const compare = a.shares.length >= 2 && by;
  const [mid1, right] = cols(ROWS.mid.y, ROWS.mid.h, [7, 5]);
  const [low1, low2] = cols(ROWS.low.y, ROWS.low.h, a.percent || compare || (a.lat && a.lon) ? [5, 7] : [12]);
  // Allocation : la comparaison des parts prend la grande place, le classement des valeurs passe dessous.
  const left = compare ? low1 : mid1;
  if (compare && mid1) {
    const target = a.shares.find((c) => has(c, /cible|objectif|target/));
    visuals.push(
      visual(
        "bar",
        id,
        mid1,
        { category: [dim(by!)], values: a.shares.slice(0, 3).map((c) => measure(c, "sum", c.name)) },
        { ...numberOptions(a.shares[0]), legend: true, labels: true },
        `${target ? "Cible et réalisé" : "Parts"} par ${lower(by!.name)}`,
      ),
    );
  }
  if (main && by && left) {
    visuals.push(
      visual(
        "bar",
        id,
        left,
        { category: [dim(by)], values: [measure(main, "sum", main.name)], ...(second ? { tooltips: [natural(second)] } : {}) },
        { ...numberOptions(main), sort: "value_desc", labels: true, ...(by.distinct > 12 ? { topN: 12 } : {}) },
        by.distinct > 12 ? `Top 12 — ${lower(main.name)} par ${lower(by.name)}` : `${main.name} par ${lower(by.name)}`,
      ),
    );
  }
  if (right) {
    if (a.status) visuals.push(share(a, right, a.status, { field: a.status.name, agg: "count", label: "Nombre" }, `Répartition par ${lower(a.status.name)}`));
    else if (main && group) visuals.push(share(a, right, group, measure(main, "sum", main.name), `${main.name} par ${lower(group.name)}`));
    else if (main && by && by.distinct <= 8) visuals.push(share(a, right, by, measure(main, "sum", main.name), `Répartition — ${lower(main.name)}`));
  }

  const located = !!(a.lat && a.lon);
  if (located && low1 && !a.percent && !compare) {
    visuals.push(
      visual("pointmap", id, low1, { lat: [dim(a.lat!)], lon: [dim(a.lon!)], ...(main ? { size: [measure(main, "sum", main.name)] } : {}), ...(named ? { label: [dim(named)] } : {}) }, { basemap: "france" }, `Carte — ${lower(a.label)}`),
    );
  }
  if (a.percent && by && low1 && !compare) {
    visuals.push(visual("bar", id, low1, { category: [dim(by)], values: [measure(a.percent, "avg", a.percent.name)] }, { ...numberOptions(a.percent), sort: "value_asc", labels: true }, `${a.percent.name} par ${lower(by.name)}`));
  }
  const tableRect = a.percent || located || compare ? low2 : low1;
  if (tableRect) {
    const columns = [named, by, a.status, group].filter((c, i, all): c is ColumnProfile => !!c && all.indexOf(c) === i).map((c) => dim(c));
    const date = a.ds.columns.find((c) => c.type === "date");
    if (date) columns.push(dim(date, "day"));
    const values = [main, second].filter((c): c is ColumnProfile => !!c).map((c) => natural(c));
    visuals.push(visual("table", id, tableRect, { columns, values }, { ...numberOptions(main), compact: false, sort: "value_desc", totals: true, conditional: Object.fromEntries(values.map((v) => [`sum(${v.field})`, { bars: true }])) }, a.label));
  }
  return [{ name: a.label, visuals, analysis: a }];
}

function sectionsFor(a: Analysis): Section[] {
  if (a.kind === "flows") return flowSections(a);
  if (a.kind === "events") return eventSections(a);
  return listSections(a);
}

// ─── Points d'entrée ────────────────────────────────────────────────────────────────────────────────────

/** Rapport de démarrage d'un jeu : pages adaptées à sa nature, filtres à gauche, navigation en haut. */
export function starterPages(ds: DatasetProfile): Page[] {
  const a = analyze(ds);
  const sections = sectionsFor(a);
  if (sections[0] && a.kind !== "list") sections[0] = { ...sections[0], name: "Vue d'ensemble" };
  return finish(sections, shortName(ds.name) === "Opérations" ? ds.name.split(" — ")[0] ?? ds.name : shortName(ds.name));
}

/**
 * Rapport d'une histoire (plusieurs jeux) : les pages de chaque jeu, dans l'ordre donné, reliées par un même
 * navigateur. Les opérations donnent « Trésorerie », « Dépenses », « Opérations » ; chaque table métier sa page.
 */
export function storyPages(title: string, datasets: DatasetProfile[]): Page[] {
  const sections: Section[] = [];
  for (const ds of datasets) {
    const a = analyze(ds);
    const own = sectionsFor(a);
    // Une seule page par table métier dans un rapport à plusieurs jeux (le détail reste dans la page).
    sections.push(...(a.kind === "flows" || datasets.length === 1 ? own : own.slice(0, 1)));
  }
  return finish(sections, title);
}
