import { Plus, X } from "lucide-react";
import { useState } from "react";

import type { ColumnProfile, DatasetProfile, Scalar } from "../../types/dataset";
import type { Filter } from "../../types/query";
import type { Visual } from "../../types/report";
import { valueKey } from "../../visuals/common";
import { formatDimension } from "../../visuals/format";
import { useQueryResult } from "../../visuals/useQueryResult";
import { useStudioData } from "../context";
import { useStudio } from "../store";
import { Pane, Section } from "./Pane";

/** Volet Filtres : filtres du visuel sélectionné et de toute la page. */
export function FiltersPane() {
  const report = useStudio((s) => s.report);
  const pageId = useStudio((s) => s.pageId);
  const selectedId = useStudio((s) => s.selectedId);
  const { profiles, activeDatasetId } = useStudioData();
  const page = report?.pages.find((p) => p.id === pageId);
  const visual = page?.visuals.find((v) => v.id === selectedId);
  if (!page) return null;

  const pageDataset = profiles.get(visual?.dataset_id ?? activeDatasetId ?? "");
  const visualDataset = visual?.dataset_id ? profiles.get(visual.dataset_id) : undefined;
  const s = useStudio.getState;

  return (
    <Pane title="Filtres" width="w-56" defaultOpen={false}>
      {visual && visualDataset && (
        <Section title="Sur ce visuel">
          <FilterList
            dataset={visualDataset}
            filters={visual.filters}
            onChange={(filters) => s().updateVisual(visual.id, (v: Visual) => (v.filters = filters))}
          />
        </Section>
      )}
      <Section title="Sur cette page">
        {pageDataset ? (
          <FilterList dataset={pageDataset} filters={page.filters} onChange={(f) => s().setPageFilters(f)} />
        ) : (
          <p className="text-[11px] text-muted">Choisissez un jeu de données.</p>
        )}
      </Section>
    </Pane>
  );
}

function FilterList({ dataset, filters, onChange }: { dataset: DatasetProfile; filters: Filter[]; onChange: (f: Filter[]) => void }) {
  const [adding, setAdding] = useState(false);
  const columns = dataset.columns.filter((c) => !filters.some((f) => f.field === c.name));

  return (
    <div className="space-y-2">
      {filters.map((f, i) => {
        const column = dataset.columns.find((c) => c.name === f.field);
        if (!column) return null;
        return (
          <FilterCard
            key={f.field}
            dataset={dataset}
            column={column}
            filter={f}
            onChange={(nf) => onChange(filters.map((x, j) => (j === i ? nf : x)))}
            onRemove={() => onChange(filters.filter((_, j) => j !== i))}
          />
        );
      })}
      {adding ? (
        <select
          autoFocus
          aria-label="Champ à filtrer"
          defaultValue=""
          onChange={(e) => {
            const c = dataset.columns.find((x) => x.name === e.target.value);
            if (c) onChange([...filters, emptyFilter(c)]);
            setAdding(false);
          }}
          onBlur={() => setAdding(false)}
          className="w-full rounded-md border border-border bg-bg px-2 py-1 text-xs"
        >
          <option value="" disabled>
            Choisir un champ…
          </option>
          {columns.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
      ) : (
        <button type="button" onClick={() => setAdding(true)} className="flex items-center gap-1 text-[11px] font-medium text-accent hover:underline">
          <Plus className="size-3" aria-hidden /> Ajouter un filtre
        </button>
      )}
    </div>
  );
}

function emptyFilter(c: ColumnProfile): Filter {
  return c.type === "number" || c.type === "date"
    ? { field: c.name, op: "between", values: [null, null] }
    : { field: c.name, op: "in", values: [] };
}

function FilterCard({
  dataset,
  column,
  filter,
  onChange,
  onRemove,
}: {
  dataset: DatasetProfile;
  column: ColumnProfile;
  filter: Filter;
  onChange: (f: Filter) => void;
  onRemove: () => void;
}) {
  const isRange = filter.op === "between";
  const values = useQueryResult(
    isRange ? null : { dataset_id: dataset.id, dimensions: [{ field: column.name }], measures: [{ agg: "count" }], limit: 200 },
  );
  const selected = new Set(filter.values.map(valueKey));

  return (
    <div className="rounded-md border border-border p-2 text-[11px]">
      <div className="mb-1.5 flex items-center justify-between gap-1">
        <span className="truncate font-medium">{column.name}</span>
        <button type="button" onClick={onRemove} aria-label={`Supprimer le filtre ${column.name}`} className="text-muted hover:text-negative">
          <X className="size-3" aria-hidden />
        </button>
      </div>
      {isRange ? (
        <div className="grid grid-cols-2 gap-1">
          {[0, 1].map((i) => (
            <input
              key={i}
              aria-label={i === 0 ? "Minimum" : "Maximum"}
              type={column.type === "date" ? "date" : "number"}
              placeholder={i === 0 ? "min" : "max"}
              value={filter.values[i] === null || filter.values[i] === undefined ? "" : String(filter.values[i]).slice(0, column.type === "date" ? 10 : undefined)}
              onChange={(e) => {
                const next: Scalar[] = [filter.values[0] ?? null, filter.values[1] ?? null];
                next[i] = e.target.value === "" ? null : column.type === "date" ? e.target.value : Number(e.target.value);
                onChange({ ...filter, values: next });
              }}
              className="w-full rounded border border-border bg-bg px-1.5 py-0.5"
            />
          ))}
        </div>
      ) : (
        <ul className="max-h-40 space-y-0.5 overflow-auto">
          {(values.result?.rows ?? []).map((r) => {
            const raw = r[column.name] ?? null;
            const on = selected.has(valueKey(raw));
            return (
              <li key={valueKey(raw)}>
                <label className="flex cursor-pointer items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() =>
                      onChange({
                        ...filter,
                        values: on ? filter.values.filter((v) => valueKey(v) !== valueKey(raw)) : [...filter.values, raw],
                      })
                    }
                    className="accent-[var(--accent)]"
                  />
                  <span className="truncate">{formatDimension(raw, column.type)}</span>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {!isRange && (
        <label className="mt-1.5 flex items-center gap-1.5 text-muted">
          <input
            type="checkbox"
            checked={filter.op === "not_in"}
            onChange={(e) => onChange({ ...filter, op: e.target.checked ? "not_in" : "in" })}
            className="accent-[var(--accent)]"
          />
          Exclure la sélection
        </label>
      )}
    </div>
  );
}
