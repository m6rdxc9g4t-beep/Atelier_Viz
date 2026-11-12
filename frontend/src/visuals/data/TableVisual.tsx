import clsx from "clsx";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useMemo, useState } from "react";

import type { Scalar } from "../../types/dataset";
import { columnType } from "../charts/series";
import { VisualMessage, dimmed, numberFormat, role, toggleSelection } from "../common";
import { bindingKey, bindingLabel } from "../fields";
import { formatDimension, formatNumber } from "../format";
import { opt, type VisualProps } from "../types";
import { type CondFormat, type Decor, GLYPHS, decorStyle, decorate, formatFor, statsOf, toneCss } from "./conditional";

/**
 * Lignes d'en-tête et de total figées : `position: sticky` se pose sur les **cellules**, jamais sur `tr`,
 * `thead` ou `tfoot` (Safari place mal une ligne collante, des lignes se dessinent alors sous le total).
 * Bordures séparées (`border-separate`) : en `border-collapse`, le trait d'une cellule collante ne la suit pas.
 * Les cellules débordent d'un pixel de la zone défilante : à une échelle de page fractionnaire, un liseré des
 * lignes qui défilent apparaissait sinon au-dessus de l'en-tête et sous le total.
 */
export const STICKY_HEAD = "sticky -top-px z-10 bg-surface";
export const STICKY_FOOT = "sticky -bottom-px z-10 bg-surface";
export const DATA_TABLE = "w-full border-separate border-spacing-0 text-xs";

/** Table : dimensions + mesures, tri par clic sur l'en-tête, total, barres de données. */
export function TableVisual(props: VisualProps) {
  const { visual, def, result, dataset, selection, onSelect } = props;
  const dims = role(visual, "columns");
  const measures = role(visual, "values");
  const [sort, setSort] = useState<{ key: string; desc: boolean } | null>(null);
  const showTotals = opt<boolean>(visual, def, "totals");

  const rows = useMemo(() => {
    const list = [...(result?.rows ?? [])];
    if (sort) {
      list.sort((a, b) => {
        const x = a[sort.key] ?? null;
        const y = b[sort.key] ?? null;
        const cmp = x === null ? 1 : y === null ? -1 : typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y), "fr", { numeric: true });
        return sort.desc ? -cmp : cmp;
      });
    }
    return list;
  }, [result, sort]);

  if (!result) return null;
  if (!rows.length) return <VisualMessage>Aucune donnée pour ces filtres.</VisualMessage>;

  // Mise en forme conditionnelle : statistiques des valeurs affichées de chaque mesure.
  const formats = new Map<string, CondFormat>(measures.map((m) => [bindingKey(m), formatFor(visual, bindingKey(m))]));
  const stats = new Map(measures.map((m) => [bindingKey(m), statsOf(rows.map((r) => r[bindingKey(m)] as number | null))]));
  // Total = somme des lignes : exact pour somme et nombre ; pour les autres agrégations on n'affiche rien.
  const totals = Object.fromEntries(
    measures.map((m) => [
      bindingKey(m),
      // Total = somme des lignes : exact pour somme et nombre ; jamais pour un cumul, un N-1 ou un %.
      (m.agg === "sum" || m.agg === "count") && !m.show ? rows.reduce((t, r) => t + Number(r[bindingKey(m)] ?? 0), 0) : null,
    ]),
  );
  const firstDim = dims[0];
  const header = (key: string, label: string, numeric: boolean) => {
    const active = sort?.key === key;
    return (
      <th key={key} scope="col" className={clsx(STICKY_HEAD, "border-b border-border px-2 py-1.5 font-medium text-muted", numeric ? "text-right" : "text-left")}>
        <button
          type="button"
          onClick={() => setSort((s) => (s?.key === key ? (s.desc ? null : { key, desc: true }) : { key, desc: false }))}
          className="inline-flex items-center gap-1 whitespace-nowrap hover:text-fg"
        >
          {label}
          {active && (sort.desc ? <ArrowDown className="size-3" aria-label="décroissant" /> : <ArrowUp className="size-3" aria-label="croissant" />)}
        </button>
      </th>
    );
  };

  return (
    <div className="h-full overflow-auto">
      <table className={DATA_TABLE}>
        <thead>
          <tr>
            {dims.map((d) => header(bindingKey(d), bindingLabel(d), false))}
            {measures.map((m) => header(bindingKey(m), bindingLabel(m), true))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const firstValue: Scalar = firstDim ? (r[bindingKey(firstDim)] ?? null) : null;
            return (
              <tr
                key={i}
                onClick={() => firstDim && toggleSelection(selection, visual, firstDim, firstValue, onSelect)}
                className={clsx(
                  "cursor-pointer hover:bg-surface-2",
                  firstDim && dimmed(selection, visual, firstValue) && "opacity-40",
                )}
              >
                {dims.map((d) => (
                  <td key={bindingKey(d)} className="whitespace-nowrap border-b border-border/60 px-2 py-1">
                    {formatDimension(r[bindingKey(d)] ?? null, columnType(dataset, d.field), d.bin)}
                  </td>
                ))}
                {measures.map((m) => {
                  const key = bindingKey(m);
                  const raw = r[key] ?? null;
                  const decor = formats.get(key) ? decorate(typeof raw === "number" ? raw : null, formats.get(key) as CondFormat, stats.get(key) ?? null) : {};
                  return (
                    <td key={key} className="relative whitespace-nowrap border-b border-border/60 px-2 py-1 text-right tabular-nums" style={decorStyle(decor)}>
                      <DecoratedValue decor={decor} text={formatNumber(raw, numberFormat(visual, m))} />
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
        {showTotals && measures.length > 0 && (
          <tfoot>
            <tr className="font-semibold">
              {dims.map((d, i) => (
                <td key={bindingKey(d)} className={clsx(STICKY_FOOT, "border-t border-border px-2 py-1.5")}>
                  {i === 0 ? "Total" : ""}
                </td>
              ))}
              {measures.map((m) => (
                <td key={bindingKey(m)} className={clsx(STICKY_FOOT, "border-t border-border px-2 py-1.5 text-right tabular-nums")}>
                  {totals[bindingKey(m)] === null ? "" : formatNumber(totals[bindingKey(m)] ?? null, numberFormat(visual, m))}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
      {result.truncated && <p className="px-2 py-1 text-[10px] text-muted">Résultat tronqué — affinez avec des filtres ou un Top N.</p>}
    </div>
  );
}

/**
 * Valeur d'une cellule avec sa barre de données et son icône éventuelles. La barre part du bord gauche de la
 * cellule (base commune à toute la colonne, comme dans un tableur) : collée au nombre aligné à droite, une
 * barre courte se lisait comme un surlignage du texte.
 */
export function DecoratedValue({ decor, text }: { decor: Decor; text: string }) {
  return (
    <>
      {decor.bar && (
        <span
          aria-hidden
          data-bar
          className="absolute inset-y-1 left-1 rounded-sm"
          style={{
            width: `calc(${decor.bar.ratio * 100}% - 8px)`,
            backgroundColor: `color-mix(in oklab, ${toneCss(decor.bar.negative ? "div-neg" : "seq")} 30%, transparent)`,
          }}
        />
      )}
      {decor.icon && (
        <span className="relative mr-1 text-[9px]" style={{ color: toneCss(decor.icon.tone) }} role="img" aria-label={decor.icon.label}>
          {GLYPHS[decor.icon.glyph]}
        </span>
      )}
      <span className="relative">{text}</span>
    </>
  );
}
