import clsx from "clsx";
import { ChevronRight } from "lucide-react";
import { Fragment, useMemo, useState } from "react";

import { columnType } from "../charts/series";
import { VisualMessage, first, numberFormat, role, valueKey } from "../common";
import { bindingKey, bindingLabel } from "../fields";
import { formatDimension, formatNumber } from "../format";
import { opt, type VisualProps } from "../types";
import { type MatrixNode, buildMatrix } from "./pivot";
import { type CondFormat, type Stats, decorStyle, decorate, formatFor, statsOf } from "./conditional";
import { DecoratedValue, PinnedTotalTable, STICKY_HEAD, type TotalCell } from "./TableVisual";

/** Matrice : lignes hiérarchiques dépliables, colonne pivot, sous-totaux et total général exacts. */
export function MatrixVisual(props: VisualProps) {
  const { visual, def, result, dataset } = props;
  const rows = role(visual, "rows");
  const column = first(visual, "columns");
  const values = role(visual, "values");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const expandAll = opt<boolean>(visual, def, "expanded");

  const model = useMemo(() => (result ? buildMatrix(result.rows, rows, column) : null), [result, rows, column]);
  if (!model) return null;
  if (!model.root.children.length && !model.root.cells.size) return <VisualMessage>Aucune donnée pour ces filtres.</VisualMessage>;

  const colKeys = [...model.columns.map(valueKey), "__total"];

  // Mise en forme conditionnelle : statistiques sur les cellules affichées (hors colonne Total).
  const visible: MatrixNode[] = [];
  const collect = (n: MatrixNode) => {
    visible.push(n);
    if (n.level < rows.length && (expandAll || open.has(n.path))) n.children.forEach(collect);
  };
  model.root.children.forEach(collect);
  const formats = new Map<string, CondFormat>(values.map((m) => [bindingKey(m), formatFor(visual, bindingKey(m))]));
  const stats = new Map<string, Stats | null>(
    values.map((m) => [
      bindingKey(m),
      statsOf(visible.flatMap((n) => colKeys.filter((k) => k !== "__total").map((k) => n.cells.get(k)?.[bindingKey(m)] as number | null))),
    ]),
  );
  const cellDecor = (raw: unknown, key: string, total: boolean) =>
    total || typeof raw !== "number" ? {} : decorate(raw, formats.get(key) as CondFormat, stats.get(key) ?? null);
  const colType = columnType(dataset, column?.field);
  const colLabel = (k: string, i: number) =>
    k === "__total" ? "Total" : formatDimension(model.columns[i] ?? null, colType, column?.bin);

  const toggle = (path: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const renderNode = (node: MatrixNode): React.ReactNode => {
    const binding = rows[node.level - 1];
    const isLeaf = node.level >= rows.length;
    const expanded = expandAll || open.has(node.path);
    return (
      <Fragment key={node.path}>
        <tr className={clsx("hover:bg-surface-2", !isLeaf && "font-medium")}>
          <th scope="row" className="whitespace-nowrap border-b border-border/60 px-2 py-1 text-left font-[inherit]" style={{ paddingLeft: 8 + (node.level - 1) * 16 }}>
            {!isLeaf ? (
              <button type="button" onClick={() => toggle(node.path)} aria-expanded={expanded} className="inline-flex items-center gap-1">
                <ChevronRight className={clsx("size-3 transition-transform", expanded && "rotate-90")} aria-hidden />
                {binding ? formatDimension(node.value, columnType(dataset, binding.field), binding.bin) : ""}
              </button>
            ) : (
              <span className="pl-4">{binding ? formatDimension(node.value, columnType(dataset, binding.field), binding.bin) : ""}</span>
            )}
          </th>
          {colKeys.map((ck) =>
            values.map((m) => {
              const raw = node.cells.get(ck)?.[bindingKey(m)] ?? null;
              const decor = cellDecor(raw, bindingKey(m), ck === "__total");
              return (
                <td
                  key={`${ck}-${bindingKey(m)}`}
                  className={clsx("relative whitespace-nowrap border-b border-border/60 px-2 py-1 text-right tabular-nums", ck === "__total" && "bg-surface-2/60")}
                  style={decorStyle(decor)}
                >
                  {node.cells.get(ck) ? <DecoratedValue decor={decor} text={formatNumber(raw, numberFormat(visual, m))} /> : ""}
                </td>
              );
            }),
          )}
        </tr>
        {!isLeaf && expanded && node.children.map(renderNode)}
      </Fragment>
    );
  };

  const total: TotalCell[] = [
    { key: "__label", text: "Total", numeric: false, header: true },
    ...colKeys.flatMap((ck) =>
      values.map((m) => ({ key: `t-${ck}-${bindingKey(m)}`, text: formatNumber(model.root.cells.get(ck)?.[bindingKey(m)] ?? null, numberFormat(visual, m)), numeric: true })),
    ),
  ];

  return (
    <PinnedTotalTable
      head={
        <>
          <tr>
            <th rowSpan={values.length > 1 ? 2 : 1} className={clsx(STICKY_HEAD, "border-b border-border px-2 py-1.5 text-left font-medium text-muted")}>
              {rows.map(bindingLabel).join(" › ")}
            </th>
            {colKeys.map((ck, i) => (
              <th key={ck} colSpan={values.length} className={clsx(STICKY_HEAD, "whitespace-nowrap border-b border-border px-2 py-1.5 text-right font-medium text-muted")}>
                {column ? colLabel(ck, i) : values.length === 1 && values[0] ? bindingLabel(values[0]) : "Valeurs"}
              </th>
            ))}
          </tr>
          {values.length > 1 && (
            <tr>
              {colKeys.map((ck) =>
                values.map((m) => (
                  // Seconde ligne d'en-tête : collée sous la première (29 px : 12 px de marges, 16 px de texte, 1 px de trait).
                  <th key={`${ck}-${bindingKey(m)}`} className="sticky top-[28px] z-10 whitespace-nowrap border-b border-border bg-surface px-2 py-1 text-right text-[10px] font-normal text-muted">
                    {bindingLabel(m)}
                  </th>
                )),
              )}
            </tr>
          )}
        </>
      }
      total={total}
    >
      {model.root.children.map(renderNode)}
    </PinnedTotalTable>
  );
}
