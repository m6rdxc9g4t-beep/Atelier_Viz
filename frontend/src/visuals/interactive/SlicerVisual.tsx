import clsx from "clsx";
import { Check, Search, X } from "lucide-react";
import { useState } from "react";

import type { Scalar } from "../../types/dataset";
import { columnType } from "../charts/series";
import { VisualMessage, first, valueKey } from "../common";
import { bindingKey } from "../fields";
import { formatDimension, formatNumber } from "../format";
import { opt, type VisualProps } from "../types";

/**
 * Segment : filtre interactif qui s'applique aux autres visuels de la page (même jeu de données).
 * La sélection est enregistrée dans le rapport (options.selected / options.range).
 */
export function SlicerVisual(props: VisualProps) {
  const { visual, def, result, dataset, setOptions } = props;
  const field = first(visual, "field");
  const style = opt<string>(visual, def, "style");
  const multi = opt<boolean>(visual, def, "multi");
  const [search, setSearch] = useState("");
  if (!field || !result) return null;

  const type = columnType(dataset, field.field);

  if (style === "range") {
    if (type !== "number" && type !== "date") {
      return <VisualMessage>La plage s'applique aux champs numériques ou de date.</VisualMessage>;
    }
    const row = result.rows[0];
    const lo = row?.[`min(${field.field})`] ?? null;
    const hi = row?.[`max(${field.field})`] ?? null;
    const range = (visual.options.range as [Scalar, Scalar] | undefined) ?? [null, null];
    const input = type === "date" ? "date" : "number";
    const toInput = (v: Scalar) => (v === null ? "" : type === "date" ? String(v).slice(0, 10) : String(v));
    const fromInput = (s: string): Scalar => (s === "" ? null : type === "date" ? s : Number(s));
    return (
      <div className="flex h-full flex-col justify-center gap-2 text-xs">
        <div className="grid grid-cols-2 gap-2">
          {(["Du", "Au"] as const).map((label, i) => (
            <label key={label} className="flex flex-col gap-1 text-muted">
              {label}
              <input
                type={input}
                value={toInput(range[i] ?? null)}
                placeholder={toInput(i === 0 ? lo : hi)}
                min={toInput(lo)}
                max={toInput(hi)}
                onChange={(e) => {
                  const next: [Scalar, Scalar] = [range[0] ?? null, range[1] ?? null];
                  next[i] = fromInput(e.target.value);
                  setOptions({ range: next });
                }}
                className="w-full rounded-md border border-border bg-bg px-2 py-1 text-fg"
              />
            </label>
          ))}
        </div>
        <p className="text-[10px] text-muted">
          Données : {formatDimension(lo, type)} → {formatDimension(hi, type)}
          {(range[0] !== null || range[1] !== null) && (
            <button type="button" onClick={() => setOptions({ range: [null, null] })} className="ml-2 text-accent hover:underline">
              Effacer
            </button>
          )}
        </p>
      </div>
    );
  }

  const key = bindingKey(field);
  const selected = new Set(((visual.options.selected as Scalar[] | undefined) ?? []).map(valueKey));
  const items = result.rows
    .map((r) => ({ raw: r[key] ?? null, count: Number(r["count(*)"] ?? 0) }))
    .filter((it) => !search || formatDimension(it.raw, type, field.bin).toLowerCase().includes(search.toLowerCase()));
  const all = result.rows.map((r) => r[key] ?? null);

  const toggle = (raw: Scalar) => {
    const k = valueKey(raw);
    let next: Scalar[];
    if (multi) {
      next = all.filter((v) => (valueKey(v) === k ? !selected.has(k) : selected.has(valueKey(v))));
    } else {
      next = selected.has(k) && selected.size === 1 ? [] : [raw];
    }
    setOptions({ selected: next });
  };
  const clear = () => setOptions({ selected: [] });

  if (style === "dropdown") {
    return (
      <div className="flex h-full items-center gap-2">
        <select
          aria-label={`Filtrer par ${field.field}`}
          value={selected.size === 1 ? [...selected][0] : ""}
          onChange={(e) => {
            const raw = all.find((v) => valueKey(v) === e.target.value);
            setOptions({ selected: e.target.value === "" || raw === undefined ? [] : [raw] });
          }}
          className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-xs"
        >
          <option value="">Tout</option>
          {all.map((v) => (
            <option key={valueKey(v)} value={valueKey(v)}>
              {formatDimension(v, type, field.bin)}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (style === "tiles") {
    return (
      <div className="flex h-full flex-wrap content-start gap-1.5 overflow-auto">
        {all.map((v) => (
          <button
            key={valueKey(v)}
            type="button"
            aria-pressed={selected.has(valueKey(v))}
            onClick={() => toggle(v)}
            className={clsx(
              "rounded-md border px-2.5 py-1 text-xs transition-colors",
              selected.has(valueKey(v)) ? "border-accent bg-accent text-accent-fg" : "border-border hover:bg-surface-2",
            )}
          >
            {formatDimension(v, type, field.bin)}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-1.5 text-xs">
      {opt<boolean>(visual, def, "search") && (
        <label className="flex items-center gap-1.5 rounded-md border border-border bg-bg px-2 py-1">
          <Search className="size-3 text-muted" aria-hidden />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Rechercher" className="min-w-0 flex-1 bg-transparent outline-none" />
        </label>
      )}
      <ul className="min-h-0 flex-1 overflow-auto" role="listbox" aria-multiselectable={multi}>
        {items.map((it) => {
          const on = selected.has(valueKey(it.raw));
          return (
            <li key={valueKey(it.raw)}>
              <button
                type="button"
                role="option"
                aria-selected={on}
                onClick={() => toggle(it.raw)}
                className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-surface-2"
              >
                <span className={clsx("flex size-3.5 shrink-0 items-center justify-center rounded-sm border", on ? "border-accent bg-accent text-accent-fg" : "border-border")}>
                  {on && <Check className="size-2.5" aria-hidden />}
                </span>
                <span className="min-w-0 flex-1 truncate">{formatDimension(it.raw, type, field.bin)}</span>
                <span className="tabular-nums text-muted">{formatNumber(it.count, { compact: true })}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {selected.size > 0 && (
        <button type="button" onClick={clear} className="flex items-center gap-1 self-start text-[11px] text-accent hover:underline">
          <X className="size-3" aria-hidden /> Effacer ({selected.size})
        </button>
      )}
    </div>
  );
}
