import { useState } from "react";

import type { ColumnProfile, ColumnType, PrepOp, PrepStep, Scalar, TextMode } from "../../../types/dataset";
import { OP_LABELS, STEP_LABELS, TEXT_LABELS, TYPE_LABELS, opArity, opsFor, stepProblem, typedValue } from "./steps";

const field = "rounded-md border border-border bg-field px-2 py-1 text-xs outline-none focus:border-focus";
const label = "flex flex-col gap-1 text-[11px] text-muted";
const SEPARATORS: [string, string][] = [
  [" ", "espace"],
  [",", ","],
  [";", ";"],
  ["-", "-"],
  ["/", "/"],
];

interface Props {
  step: PrepStep;
  /** Colonnes disponibles avant cette étape. */
  columns: ColumnProfile[];
  editing: boolean;
  onChange: (step: PrepStep) => void;
  onSubmit: () => void;
  onCancel: () => void;
}

/** Réglages d'une étape (ajout ou modification). */
export function StepForm({ step, columns, editing, onChange, onSubmit, onCancel }: Props) {
  const problem = stepProblem(step);
  const typeOf = (name: string) => columns.find((c) => c.name === name)?.type;
  const set = (patch: Partial<PrepStep>) => onChange({ ...step, ...patch } as PrepStep);

  const columnSelect = (value: string, onPick: (name: string) => void, aria = "Colonne") => (
    <label className={label}>
      Colonne
      <select aria-label={aria} value={value} onChange={(e) => onPick(e.target.value)} className={field}>
        {!columns.some((c) => c.name === value) && <option value={value}>{value || "—"}</option>}
        {columns.map((c) => (
          <option key={c.name} value={c.name}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );

  const multi = (picked: string[], onPick: (names: string[]) => void) => (
    <fieldset className="col-span-full">
      <legend className="mb-1 text-[11px] text-muted">Colonnes ({picked.length})</legend>
      <div className="flex max-h-24 flex-wrap gap-1 overflow-y-auto">
        {columns.map((c) => {
          const on = picked.includes(c.name);
          return (
            <label key={c.name} className={`flex cursor-pointer items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${on ? "border-accent-ink bg-accent-soft" : "border-border text-muted hover:bg-accent-faint"}`}>
              <input type="checkbox" className="sr-only" checked={on} onChange={() => onPick(on ? picked.filter((n) => n !== c.name) : [...picked, c.name])} />
              {c.name}
            </label>
          );
        })}
      </div>
    </fieldset>
  );

  let body: React.ReactNode = null;
  switch (step.kind) {
    case "rename":
      body = (
        <>
          {columnSelect(step.column, (column) => set({ column, to: column }))}
          <label className={label}>
            Nouveau nom
            <input autoFocus aria-label="Nouveau nom" value={step.to} onChange={(e) => set({ to: e.target.value })} className={field} maxLength={80} />
          </label>
        </>
      );
      break;
    case "remove":
      body = multi(step.columns, (columns) => set({ columns }));
      break;
    case "cast":
      body = (
        <>
          {columnSelect(step.column, (column) => set({ column }))}
          <label className={label}>
            Nouveau type
            <select aria-label="Nouveau type" value={step.to} onChange={(e) => set({ to: e.target.value as ColumnType })} className={field}>
              {(Object.keys(TYPE_LABELS) as ColumnType[]).map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
          <p className="col-span-full text-[11px] text-muted">« 1 234,50 » et « 05/01/2026 » sont reconnus ; une valeur non convertible devient vide.</p>
        </>
      );
      break;
    case "filter": {
      const type = typeOf(step.column) ?? "string";
      const arity = opArity(step.op);
      body = (
        <>
          {columnSelect(step.column, (column) => set({ column, op: opsFor(typeOf(column) ?? "string").includes(step.op) ? step.op : "eq" }))}
          <label className={label}>
            Garder les lignes où
            <select aria-label="Condition" value={step.op} onChange={(e) => set({ op: e.target.value as PrepOp })} className={field}>
              {opsFor(type).map((op) => (
                <option key={op} value={op}>
                  {OP_LABELS[op]}
                </option>
              ))}
            </select>
          </label>
          {arity !== 0 && (
            <ValuesInput
              key={`${step.column}-${arity}`}
              many={arity === "many"}
              type={type}
              values={step.values}
              suggestions={columns.find((c) => c.name === step.column)?.top_values.map((v) => v.value) ?? []}
              onChange={(values) => set({ values })}
            />
          )}
        </>
      );
      break;
    }
    case "replace": {
      const type = typeOf(step.column);
      body = (
        <>
          {columnSelect(step.column, (column) => set({ column }))}
          <label className={label}>
            Valeur cherchée
            <input aria-label="Valeur cherchée" value={step.find === null ? "" : String(step.find)} onChange={(e) => set({ find: typedValue(e.target.value, type) })} className={field} placeholder="vide = cellules vides" />
          </label>
          <label className={label}>
            Remplacer par
            <input aria-label="Remplacer par" value={step.replace === null ? "" : String(step.replace)} onChange={(e) => set({ replace: e.target.value === "" ? null : typedValue(e.target.value, type) })} className={field} placeholder="vide = effacer" />
          </label>
          {type === "string" && (
            <label className="flex items-center gap-1.5 self-end text-xs">
              <input type="checkbox" checked={!step.whole} onChange={(e) => set({ whole: !e.target.checked })} className="accent-[var(--accent)]" />
              Remplacer à l'intérieur du texte
            </label>
          )}
        </>
      );
      break;
    }
    case "fill": {
      const type = typeOf(step.column);
      body = (
        <>
          {columnSelect(step.column, (column) => set({ column }))}
          <label className="flex items-center gap-1.5 self-end text-xs">
            <input type="checkbox" checked={step.down} onChange={(e) => set({ down: e.target.checked })} className="accent-[var(--accent)]" />
            Recopier la valeur précédente
          </label>
          {!step.down && (
            <label className={label}>
              Valeur
              <input aria-label="Valeur de remplacement" value={step.value === null ? "" : String(step.value)} onChange={(e) => set({ value: typedValue(e.target.value, type) })} className={field} />
            </label>
          )}
        </>
      );
      break;
    }
    case "text":
      body = (
        <>
          {columnSelect(step.column, (column) => set({ column }))}
          <label className={label}>
            Transformation
            <select aria-label="Transformation" value={step.mode} onChange={(e) => set({ mode: e.target.value as TextMode })} className={field}>
              {(Object.keys(TEXT_LABELS) as TextMode[]).map((m) => (
                <option key={m} value={m}>
                  {TEXT_LABELS[m]}
                </option>
              ))}
            </select>
          </label>
        </>
      );
      break;
    case "dedupe":
      body = (
        <>
          <label className="col-span-full flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={step.columns === null} onChange={(e) => set({ columns: e.target.checked ? null : [] })} className="accent-[var(--accent)]" />
            Lignes entièrement identiques
          </label>
          {step.columns !== null && multi(step.columns, (columns) => set({ columns }))}
        </>
      );
      break;
    case "unpivot":
      body = (
        <>
          {multi(step.columns, (columns) => set({ columns }))}
          <label className={label}>
            Colonne des noms
            <input aria-label="Colonne des noms" value={step.attribute} onChange={(e) => set({ attribute: e.target.value })} className={field} />
          </label>
          <label className={label}>
            Colonne des valeurs
            <input aria-label="Colonne des valeurs" value={step.value} onChange={(e) => set({ value: e.target.value })} className={field} />
          </label>
        </>
      );
      break;
    case "split":
      body = (
        <>
          {columnSelect(step.column, (column) => set({ column }))}
          <div className={label}>
            Séparateur
            <div className="flex items-center gap-1">
              <input aria-label="Séparateur" value={step.separator} onChange={(e) => set({ separator: e.target.value })} className={`${field} w-16 font-mono`} maxLength={10} />
              {SEPARATORS.map(([sep, name]) => (
                <button
                  key={name}
                  type="button"
                  aria-pressed={step.separator === sep}
                  onClick={() => set({ separator: sep })}
                  className={`rounded border px-1.5 py-0.5 text-[11px] ${step.separator === sep ? "border-accent-ink bg-accent-soft text-fg" : "border-border hover:bg-accent-faint"}`}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>
          <label className={`${label} col-span-full`}>
            Nouvelles colonnes (séparées par des virgules)
            <input
              aria-label="Nouvelles colonnes"
              value={step.into.join(", ")}
              onChange={(e) => set({ into: e.target.value.split(",").map((n) => n.trim()) })}
              className={field}
            />
          </label>
        </>
      );
      break;
  }

  return (
    <form
      aria-label={`Étape : ${STEP_LABELS[step.kind]}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem) onSubmit();
      }}
      className="atelier-card space-y-2 rounded-lg border border-border bg-surface p-3"
    >
      <p className="text-xs font-semibold">{STEP_LABELS[step.kind]}</p>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">{body}</div>
      <div className="flex items-center gap-2">
        {problem && <span className="text-[11px] text-muted">{problem}</span>}
        <span className="ml-auto" />
        <button type="button" onClick={onCancel} className="rounded-md px-2.5 py-1 text-xs text-muted hover:bg-surface-2 hover:text-fg">
          Annuler
        </button>
        <button type="submit" disabled={!!problem} className="atelier-btn-primary rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg disabled:opacity-40">
          {editing ? "Modifier l'étape" : "Ajouter l'étape"}
        </button>
      </div>
    </form>
  );
}

/** Une valeur, ou une liste de valeurs séparées par « ; » (avec suggestions de la colonne). */
function ValuesInput({ many, type, values, suggestions, onChange }: { many: boolean; type: ColumnType; values: Scalar[]; suggestions: string[]; onChange: (v: Scalar[]) => void }) {
  const [text, setText] = useState(values.map((v) => (v === null ? "" : String(v))).join(many ? " ; " : ""));
  const listId = `prep-values-${type}`;
  const commit = (t: string) => {
    setText(t);
    const parts = many ? t.split(";").map((p) => p.trim()).filter(Boolean) : [t.trim()];
    onChange(parts.map((p) => typedValue(p, type)));
  };
  return (
    <label className={`${label} ${many ? "col-span-2" : ""}`}>
      {many ? "Valeurs (séparées par « ; »)" : "Valeur"}
      <input aria-label="Valeur" list={listId} value={text} onChange={(e) => commit(e.target.value)} className={field} placeholder={type === "date" ? "ex. 01/01/2026" : undefined} />
      <datalist id={listId}>
        {suggestions.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </label>
  );
}
