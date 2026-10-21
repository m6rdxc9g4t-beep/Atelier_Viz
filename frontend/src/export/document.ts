/**
 * Export PDF, image et rapport HTML autonome — partie pure (testée) : tableaux de données lisibles,
 * page HTML hors ligne (aucune ressource externe), tailles PDF.
 */

import type { FieldBinding, Report, Visual } from "../types/report";
import { numberFormat } from "../visuals/common";
import { bindingKey, bindingLabel } from "../visuals/fields";
import { formatDimension, formatNumber } from "../visuals/format";
import { defaultTitle } from "../visuals/title";
import type { QueryResult } from "../visuals/useQueryResult";

export type DocumentFormat = "pdf" | "png" | "html";

/** Pixels CSS → points PDF (96 px = 72 pt). */
export const PX_TO_PT = 0.75;

export interface DataTable {
  title: string;
  columns: string[];
  /** Colonnes numériques (alignées à droite). */
  numeric: boolean[];
  rows: string[][];
  /** Lignes non reprises (au-delà de `MAX_TABLE_ROWS`). */
  more: number;
}

export const MAX_TABLE_ROWS = 200;

/** Données d'un visuel en tableau lisible (valeurs formatées comme à l'écran), ou null s'il n'en a pas. */
export function visualTable(visual: Visual, result: QueryResult | null): DataTable | null {
  if (!result || !result.columns.length || !result.rows.length) return null;
  const bindings = Object.values(visual.roles).flat();
  const byKey = new Map<string, FieldBinding>(bindings.map((b) => [bindingKey(b), b]));
  const cols = result.columns.filter((c) => c.role !== "grouping" && !c.key.startsWith("__"));
  const rows = result.rows.filter((r) => !r.__grouping);
  return {
    title: visual.title || defaultTitle(visual),
    columns: cols.map((c) => {
      const b = byKey.get(c.key);
      return b ? bindingLabel(b) : (c.field ?? c.key);
    }),
    numeric: cols.map((c) => c.role === "measure"),
    rows: rows.slice(0, MAX_TABLE_ROWS).map((r) =>
      cols.map((c) => {
        const v = r[c.key] ?? null;
        const b = byKey.get(c.key);
        return c.role === "measure" ? formatNumber(v, numberFormat(visual, b)) : formatDimension(v, c.type, b?.bin ?? null);
      }),
    ),
    more: Math.max(0, rows.length - MAX_TABLE_ROWS),
  };
}

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

export interface HtmlPage {
  id: string;
  name: string;
  /** Image de la page (data URL PNG). */
  image: string;
  width: number;
  height: number;
  /** Filtres actifs, en clair. */
  filters: string[];
  tables: DataTable[];
}

/**
 * Rapport HTML autonome : un seul fichier, lisible hors ligne et sans Atelier Viz. Pages en images,
 * filtres et données de chaque visuel en tableaux (accessibles, copiables), navigation au clavier,
 * impression d'une page par feuille. Aucune ressource externe, aucun script tiers.
 */
export function htmlReport(report: Pick<Report, "name">, pages: HtmlPage[], exportedAt: Date): string {
  const date = exportedAt.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
  const nav = pages.map((p, i) => `<a href="#${escapeHtml(p.id)}">${i + 1}. ${escapeHtml(p.name)}</a>`).join("");
  const sections = pages
    .map((p, i) => {
      const filters = p.filters.length ? p.filters.map((f) => `<li>${escapeHtml(f)}</li>`).join("") : "<li>Aucun filtre : toutes les données.</li>";
      const tables = p.tables
        .map((t) => {
          const head = t.columns.map((c, j) => `<th scope="col"${t.numeric[j] ? ' class="n"' : ""}>${escapeHtml(c)}</th>`).join("");
          const body = t.rows.map((r) => `<tr>${r.map((v, j) => `<td${t.numeric[j] ? ' class="n"' : ""}>${escapeHtml(v)}</td>`).join("")}</tr>`).join("");
          const more = t.more ? `<p class="muted">… et ${t.more} lignes de plus.</p>` : "";
          return `<details><summary>${escapeHtml(t.title)}</summary><div class="scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${more}</details>`;
        })
        .join("");
      return `<section id="${escapeHtml(p.id)}" class="page" aria-label="Page ${i + 1} : ${escapeHtml(p.name)}">
<h2><span class="muted">${i + 1} / ${pages.length}</span> ${escapeHtml(p.name)}</h2>
<img src="${p.image}" width="${p.width}" height="${p.height}" alt="Page « ${escapeHtml(p.name)} » : ${escapeHtml(p.tables.map((t) => t.title).join(", ") || "visuels")}">
<div class="meta"><h3>Filtres</h3><ul>${filters}</ul>${tables ? `<h3>Données des visuels</h3>${tables}` : ""}</div>
</section>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Atelier Viz">
<title>${escapeHtml(report.name)}</title>
<style>
:root{--bg:#f6f6f4;--fg:#1d1d1b;--muted:#6b6b66;--line:#deded8;--card:#fff;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ececea;--muted:#a3a39d;--line:#34342f;--card:#1e1e1c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
header{position:sticky;top:0;z-index:1;background:var(--bg);border-bottom:1px solid var(--line);padding:12px 24px}
h1{font-size:18px;margin:0}nav{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:6px;font-size:13px}nav a{color:inherit}
main{max-width:1400px;margin:0 auto;padding:16px 24px 48px}.page{margin:24px 0 40px;scroll-margin-top:96px}
h2{font-size:16px;margin:0 0 10px}h3{font-size:13px;margin:14px 0 4px}.muted{color:var(--muted);font-weight:400}
img{display:block;width:100%;height:auto;border:1px solid var(--line);border-radius:8px;background:var(--card)}
ul{margin:0;padding-left:18px}details{margin:6px 0;border:1px solid var(--line);border-radius:6px;background:var(--card)}
summary{cursor:pointer;padding:6px 10px;font-weight:600}.scroll{overflow:auto;max-height:420px}
table{border-collapse:collapse;width:100%;font-size:12px}th,td{padding:4px 10px;border-top:1px solid var(--line);text-align:left;white-space:nowrap}
.n{text-align:right;font-variant-numeric:tabular-nums}footer{color:var(--muted);font-size:12px;text-align:center;padding:16px}
@media print{header{position:static}nav,details,.meta h3:last-of-type{display:none}.page{break-after:page;margin:0}img{border:0}body{background:#fff;color:#000}}
</style>
</head>
<body>
<header><h1>${escapeHtml(report.name)}</h1><nav aria-label="Pages">${nav}</nav></header>
<main>
${sections}
</main>
<footer>Exporté le ${escapeHtml(date)} depuis Atelier Viz · instantané, sans connexion aux données. Flèches ← → : page précédente / suivante.</footer>
<script>
(function(){var p=[].slice.call(document.querySelectorAll(".page"));function cur(){var y=window.scrollY+120,i=0;p.forEach(function(s,j){if(s.offsetTop<=y)i=j});return i}
document.addEventListener("keydown",function(e){if(e.target.closest&&e.target.closest("summary,input"))return;var d=e.key==="ArrowRight"||e.key==="PageDown"?1:e.key==="ArrowLeft"||e.key==="PageUp"?-1:0;if(!d)return;var t=p[Math.min(p.length-1,Math.max(0,cur()+d))];if(t){e.preventDefault();t.scrollIntoView({behavior:"smooth"})}})})();
</script>
</body>
</html>
`;
}
