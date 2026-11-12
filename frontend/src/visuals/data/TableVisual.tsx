import clsx from "clsx";
import { ArrowDown, ArrowUp } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import type { Scalar } from "../../types/dataset";
import { columnType } from "../charts/series";
import { VisualMessage, dimmed, numberFormat, role, toggleSelection } from "../common";
import { bindingKey, bindingLabel } from "../fields";
import { formatDimension, formatNumber } from "../format";
import { opt, type VisualProps } from "../types";
import { type CondFormat, type Decor, GLYPHS, decorStyle, decorate, formatFor, statsOf, toneCss } from "./conditional";

/**
 * En-tête figé : `position: sticky` en haut, posé sur les **cellules** (jamais sur `tr` ni `thead`), bordures
 * séparées (`border-separate` : en `border-collapse`, le trait d'une cellule collante ne la suit pas). Les
 * cellules débordent d'un pixel de la zone défilante : à une échelle de page fractionnaire, un liseré des
 * lignes qui défilent apparaissait sinon au-dessus de l'en-tête.
 *
 * Le total, lui, n'est **jamais** collé en bas (`sticky` + `bottom`) : sous le `transform: scale` du canvas,
 * Safari calcule la limite basse à l'échelle du zoom et pose la ligne à hauteur × zoom, au milieu du
 * tableau, des lignes dessinées dessous. Il sort de la zone défilante : voir `PinnedTotalTable`.
 */
export const STICKY_HEAD = "sticky -top-px z-10 bg-surface";
export const DATA_TABLE = "w-full border-separate border-spacing-0 text-xs";

/** Cellule de la ligne Total : une par colonne du tableau, sans fusion. */
export interface TotalCell {
  key: string;
  text: string;
  /** Nombre : aligné à droite, chiffres tabulaires. */
  numeric: boolean;
  /** Intitulé de la ligne (« Total ») : en-tête de ligne. */
  header?: boolean;
}

/** Largeurs relevées dans le tableau, reportées sur le pied : colonnes en % et largeur totale en px de page. */
export interface ColumnFit {
  columns: number[];
  width: number;
  /** Place prise par la barre de défilement verticale de la zone des lignes. */
  gutter: number;
}

/**
 * Report des largeurs de colonnes (pur) : `cells` et `table` sont des largeurs à l'écran, donc à l'échelle du
 * zoom ; `layoutWidth` est la largeur du tableau en px de page. Les parts en % ne dépendent pas de l'échelle.
 */
export function columnFit(cells: number[], table: number, layoutWidth: number, gutter: number): ColumnFit | null {
  if (!(table > 0) || !cells.length) return null;
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return { columns: cells.map((c) => round((c / table) * 100)), width: layoutWidth, gutter: Math.max(0, gutter) };
}

const sameFit = (a: ColumnFit | null, b: ColumnFit | null) =>
  a === b || (!!a && !!b && a.width === b.width && a.gutter === b.gutter && a.columns.length === b.columns.length && a.columns.every((c, i) => c === b.columns[i]));

const totalCell = (c: TotalCell) => clsx("whitespace-nowrap px-2", c.numeric ? "text-right tabular-nums" : "text-left");

/**
 * Tableau à en-tête figé et à total toujours visible. La zone défilante porte l'en-tête et les lignes ; la
 * ligne Total est affichée **sous** elle, hors défilement : rien ne peut se dessiner dessous et les dernières
 * lignes s'arrêtent juste au-dessus. Pour un tableau court, elle suit la dernière ligne.
 *
 * Le total reste une ligne du tableau (`tfoot`, sans hauteur) : elle donne aux colonnes la largeur de ses
 * nombres et garde le tableau entier pour les lecteurs d'écran. Le pied visible en est le double (`aria-hidden`),
 * calé sur les colonnes relevées dans cette ligne et sur le défilement horizontal.
 */
export function PinnedTotalTable({ head, children, total, note }: { head: ReactNode; children: ReactNode; total: TotalCell[] | null; note?: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null);
  const table = useRef<HTMLTableElement>(null);
  const sizer = useRef<HTMLTableRowElement>(null);
  const foot = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState<ColumnFit | null>(null);

  const measure = () => {
    const t = table.current;
    const row = sizer.current;
    const zone = scroller.current;
    if (!t || !row || !zone) return;
    const next = columnFit(
      [...row.cells].map((c) => c.getBoundingClientRect().width),
      t.getBoundingClientRect().width,
      t.offsetWidth,
      zone.offsetWidth - zone.clientWidth,
    );
    setFit((prev) => (sameFit(prev, next) ? prev : next));
    if (foot.current) foot.current.scrollLeft = zone.scrollLeft;
  };
  // Après chaque rendu : un tri ou un filtre change les largeurs sans changer la taille du tableau.
  useLayoutEffect(measure);
  // Et quand la place change (redimensionnement du visuel, barre de défilement, police chargée).
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    if (table.current) observer.observe(table.current);
    if (scroller.current) observer.observe(scroller.current);
    return () => observer.disconnect();
    // `measure` ne lit que des références : un seul observateur pour la vie du tableau.
  }, []);

  return (
    <div className="flex h-full flex-col">
      <div
        ref={scroller}
        data-table-scroll
        className="min-h-0 flex-initial overflow-auto"
        onScroll={(e) => {
          if (foot.current) foot.current.scrollLeft = e.currentTarget.scrollLeft;
        }}
      >
        <table ref={table} className={DATA_TABLE}>
          <thead>{head}</thead>
          <tbody>{children}</tbody>
          {total && (
            <tfoot>
              <tr ref={sizer} className="font-semibold">
                {total.map((c) => {
                  // Sans hauteur (1 px rattrapé par la marge) mais à sa largeur : la colonne fait la place du total.
                  const inner = <div className="-mb-px h-px overflow-hidden">{c.text}</div>;
                  return c.header ? (
                    <th key={c.key} scope="row" className={clsx(totalCell(c), "py-0 font-[inherit]")}>
                      {inner}
                    </th>
                  ) : (
                    <td key={c.key} className={clsx(totalCell(c), "py-0")}>
                      {inner}
                    </td>
                  );
                })}
              </tr>
            </tfoot>
          )}
        </table>
        {note}
      </div>
      {total && (
        <div ref={foot} data-table-total aria-hidden className="shrink-0 overflow-hidden" style={{ paddingRight: fit?.gutter || undefined }}>
          <table className="w-full border-separate border-spacing-0 text-xs font-semibold" style={fit ? { tableLayout: "fixed", minWidth: fit.width - 0.5 } : undefined}>
            {fit && (
              <colgroup>
                {fit.columns.map((w, i) => (
                  <col key={total[i]?.key ?? i} style={{ width: `${w}%` }} />
                ))}
              </colgroup>
            )}
            <tbody>
              <tr>
                {total.map((c) => (
                  <td key={c.key} className={clsx(totalCell(c), "overflow-hidden border-t border-border py-1.5")}>
                    {c.text}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

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

  const total: TotalCell[] | null =
    showTotals && measures.length > 0
      ? [
          ...dims.map((d, i) => ({ key: bindingKey(d), text: i === 0 ? "Total" : "", numeric: false, header: i === 0 })),
          ...measures.map((m) => {
            const value = totals[bindingKey(m)] ?? null;
            return { key: bindingKey(m), text: value === null ? "" : formatNumber(value, numberFormat(visual, m)), numeric: true };
          }),
        ]
      : null;

  return (
    <PinnedTotalTable
      head={
        <tr>
          {dims.map((d) => header(bindingKey(d), bindingLabel(d), false))}
          {measures.map((m) => header(bindingKey(m), bindingLabel(m), true))}
        </tr>
      }
      total={total}
      note={result.truncated && <p className="px-2 py-1 text-[10px] text-muted">Résultat tronqué — affinez avec des filtres ou un Top N.</p>}
    >
      {rows.map((r, i) => {
        const firstValue: Scalar = firstDim ? (r[bindingKey(firstDim)] ?? null) : null;
        return (
          <tr
            key={i}
            onClick={() => firstDim && toggleSelection(selection, visual, firstDim, firstValue, onSelect)}
            className={clsx("cursor-pointer hover:bg-surface-2", firstDim && dimmed(selection, visual, firstValue) && "opacity-40")}
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
    </PinnedTotalTable>
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
