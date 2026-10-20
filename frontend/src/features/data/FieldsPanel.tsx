import clsx from "clsx";
import { Calendar, ChevronRight, Hash, ToggleLeft, Type, type LucideIcon } from "lucide-react";
import { useState } from "react";

import { formatCount, formatValue } from "../../lib/format";
import type { ColumnProfile, ColumnType } from "../../types/dataset";

export const TYPE_META: Record<ColumnType, { icon: LucideIcon; label: string }> = {
  number: { icon: Hash, label: "Nombre" },
  string: { icon: Type, label: "Texte" },
  date: { icon: Calendar, label: "Date" },
  boolean: { icon: ToggleLeft, label: "Booléen" },
};

/** Panneau « Champs » à la Power BI : colonnes typées, statistiques au dépliage. */
export function FieldsPanel({ columns }: { columns: ColumnProfile[] }) {
  return (
    <section aria-labelledby="fields-title" className="atelier-glass flex min-h-0 flex-1 flex-col rounded-lg border border-border bg-surface">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 id="fields-title" className="text-sm font-medium">
          Champs
        </h2>
        <span className="text-xs text-muted">{columns.length}</span>
      </header>
      <ul className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {columns.map((column) => (
          <FieldItem key={column.name} column={column} />
        ))}
      </ul>
    </section>
  );
}

function FieldItem({ column }: { column: ColumnProfile }) {
  const [open, setOpen] = useState(false);
  const { icon: Icon, label } = TYPE_META[column.type];

  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-surface-2"
      >
        <ChevronRight className={clsx("size-3.5 shrink-0 text-muted transition-transform", open && "rotate-90")} aria-hidden />
        <Icon className="size-3.5 shrink-0 text-accent-ink" aria-label={label} />
        <span className="min-w-0 flex-1 truncate">{column.name}</span>
        {column.nulls > 0 && (
          <span className="text-[10px] text-muted" title={`${column.nulls} valeurs manquantes`}>
            {formatCount(column.nulls)} ∅
          </span>
        )}
      </button>
      {open && (
        <dl className="mb-1 ml-9 mr-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-md bg-surface-2 px-3 py-2 text-xs">
          <dt className="text-muted">Type</dt>
          <dd>{label}</dd>
          <dt className="text-muted">Distinctes</dt>
          <dd className="tabular-nums">{formatCount(column.distinct)}</dd>
          {column.min !== null && (
            <>
              <dt className="text-muted">Min – max</dt>
              <dd className="tabular-nums">
                {formatValue(column.min, column.type)} – {formatValue(column.max, column.type)}
              </dd>
            </>
          )}
          {column.mean !== null && (
            <>
              <dt className="text-muted">Moyenne</dt>
              <dd className="tabular-nums">{formatValue(column.mean, "number")}</dd>
            </>
          )}
          {column.top_values.length > 0 && (
            <>
              <dt className="text-muted">Fréquentes</dt>
              <dd className="flex flex-col">
                {column.top_values.slice(0, 3).map((v) => (
                  <span key={v.value} className="flex min-w-0 justify-between gap-2" title={v.value}>
                    <span className="min-w-0 truncate">{formatValue(v.value, column.type)}</span>
                    <span className="shrink-0 tabular-nums text-muted">{formatCount(v.count)}</span>
                  </span>
                ))}
              </dd>
            </>
          )}
        </dl>
      )}
    </li>
  );
}
