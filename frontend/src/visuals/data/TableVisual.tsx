import clsx from "clsx";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useMemo, useState } from "react";

import type { Scalar } from "../../types/dataset";
import { columnType } from "../charts/series";
import { VisualMessage, dimmed, numberFormat, role, toggleSelection } from "../common";
import { bindingKey, bindingLabel } from "../fields";
import { formatDimension, formatNumber } from "../format";
import { opt, type VisualProps } from "../types";

/** Table : dimensions + mesures, tri par clic sur l'en-tête, total, barres de données. */
export function TableVisual(props: VisualProps) {
  const { visual, def, result, dataset, selection, onSelect } = props;
  const dims = role(visual, "columns");
  const measures = role(visual, "values");
  const [sort, setSort] = useState<{ key: string; desc: boolean } | null>(null);
  const fmt = numberFormat(visual);
  const showTotals = opt<boolean>(visual, def, "totals");
  const dataBars = opt<boolean>(visual, def, "dataBars");

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

  const maxBy = Object.fromEntries(
    measures.map((m) => [bindingKey(m), Math.max(...rows.map((r) => Math.abs(Number(r[bindingKey(m)] ?? 0))), 1)]),
  );
  // Total = somme des lignes : exact pour somme et nombre ; pour les autres agrégations on n'affiche rien.
  const totals = Object.fromEntries(
    measures.map((m) => [
      bindingKey(m),
      m.agg === "sum" || m.agg === "count" ? rows.reduce((t, r) => t + Number(r[bindingKey(m)] ?? 0), 0) : null,
    ]),
  );
  const firstDim = dims[0];
  const header = (key: string, label: string, numeric: boolean) => {
    const active = sort?.key === key;
    return (
      <th key={key} scope="col" className={clsx("sticky top-0 z-10 border-b border-border bg-surface px-2 py-1.5 font-medium text-muted", numeric ? "text-right" : "text-left")}>
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
      <table className="w-full border-collapse text-xs">
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
                  "cursor-pointer border-b border-border/60 hover:bg-surface-2",
                  firstDim && dimmed(selection, visual, firstValue) && "opacity-40",
                )}
              >
                {dims.map((d) => (
                  <td key={bindingKey(d)} className="whitespace-nowrap px-2 py-1">
                    {formatDimension(r[bindingKey(d)] ?? null, columnType(dataset, d.field), d.bin)}
                  </td>
                ))}
                {measures.map((m) => {
                  const v = Number(r[bindingKey(m)] ?? 0);
                  return (
                    <td key={bindingKey(m)} className="relative whitespace-nowrap px-2 py-1 text-right tabular-nums">
                      {dataBars && (
                        <span
                          aria-hidden
                          className="absolute inset-y-1 right-1 rounded-sm bg-[var(--seq-200)] opacity-60"
                          style={{ width: `calc(${(Math.abs(v) / (maxBy[bindingKey(m)] ?? 1)) * 100}% - 8px)` }}
                        />
                      )}
                      <span className="relative">{formatNumber(r[bindingKey(m)] ?? null, fmt)}</span>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
        {showTotals && measures.length > 0 && (
          <tfoot>
            <tr className="sticky bottom-0 bg-surface font-semibold">
              {dims.map((d, i) => (
                <td key={bindingKey(d)} className="border-t border-border px-2 py-1.5">
                  {i === 0 ? "Total" : ""}
                </td>
              ))}
              {measures.map((m) => (
                <td key={bindingKey(m)} className="border-t border-border px-2 py-1.5 text-right tabular-nums">
                  {totals[bindingKey(m)] === null ? "" : formatNumber(totals[bindingKey(m)] ?? null, fmt)}
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
