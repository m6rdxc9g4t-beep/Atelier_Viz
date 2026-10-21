import clsx from "clsx";
import {
  ArrowRightLeft,
  Columns2,
  CopyMinus,
  Database,
  Eraser,
  Filter,
  Loader2,
  PaintBucket,
  Pencil,
  Replace,
  Rows3,
  TextCursorInput,
  Trash2,
  TriangleAlert,
  Wand2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";

import { datasetChanged, setProfile } from "../../../hooks/useDatasetProfiles";
import { api } from "../../../lib/api";
import { formatCount, formatValue } from "../../../lib/format";
import type { DatasetProfile, ModelIssue, PrepKind, PrepPreview, PrepStep } from "../../../types/dataset";
import { TYPE_META } from "../FieldsPanel";
import { StepForm } from "./StepForm";
import { STEP_LABELS, defaultStep, describeStep } from "./steps";

const ACTIONS: { kind: PrepKind; icon: LucideIcon; column: boolean }[] = [
  { kind: "rename", icon: TextCursorInput, column: true },
  { kind: "cast", icon: ArrowRightLeft, column: true },
  { kind: "filter", icon: Filter, column: true },
  { kind: "replace", icon: Replace, column: true },
  { kind: "fill", icon: PaintBucket, column: true },
  { kind: "text", icon: Eraser, column: true },
  { kind: "split", icon: Columns2, column: true },
  { kind: "remove", icon: Trash2, column: true },
  { kind: "dedupe", icon: CopyMinus, column: false },
  { kind: "unpivot", icon: Rows3, column: false },
];

interface Props {
  profile: DatasetProfile;
  onClose: () => void;
  onSaved?: (profile: DatasetProfile) => void;
}

/**
 * Éditeur de préparation à la Power Query : étapes appliquées (à gauche), aperçu du résultat à
 * l'étape choisie, actions sur la colonne sélectionnée. Rien n'est modifié avant « Appliquer ».
 */
export function PrepEditor({ profile, onClose, onSaved }: Props) {
  const titleId = useId();
  const [steps, setSteps] = useState<PrepStep[]>(profile.steps ?? []);
  /** Étape affichée : -1 = source. */
  const [at, setAt] = useState((profile.steps ?? []).length - 1);
  const [form, setForm] = useState<{ index: number | null; step: PrepStep } | null>(null);
  const [column, setColumn] = useState<string | null>(null);
  const [preview, setPreview] = useState<PrepPreview | null>(null);
  /** Colonnes avant l'étape en cours de réglage. */
  const [before, setBefore] = useState<PrepPreview | null>(null);
  const [failing, setFailing] = useState<{ step: number; error: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(steps) !== JSON.stringify(profile.steps ?? []);

  // Aperçu à l'étape affichée, ou à l'étape en cours de réglage (300 ms après le dernier changement).
  const shown = form ? (form.index === null ? [...steps.slice(0, at + 1), form.step] : steps.map((s, i) => (i === form.index ? form.step : s)).slice(0, form.index + 1)) : steps.slice(0, at + 1);
  const shownKey = JSON.stringify(shown);
  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    const t = setTimeout(() => {
      api.datasets
        .previewSteps(profile.id, JSON.parse(shownKey) as PrepStep[], ctrl.signal)
        .then(setPreview)
        .catch((e: unknown) => (e as Error).name !== "AbortError" && setError((e as Error).message))
        .finally(() => setLoading(false));
    }, 300);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [profile.id, shownKey]);

  // Colonnes disponibles pour l'étape réglée = résultat des étapes qui la précèdent.
  const formBase = form ? (form.index === null ? at + 1 : form.index) : null;
  useEffect(() => {
    if (formBase === null) return setBefore(null);
    const ctrl = new AbortController();
    api.datasets
      .previewSteps(profile.id, steps.slice(0, formBase), ctrl.signal)
      .then(setBefore)
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [profile.id, steps, formBase]);

  // Toutes les étapes : la première qui échoue est signalée dans la liste.
  const allKey = JSON.stringify(steps);
  useEffect(() => {
    const ctrl = new AbortController();
    api.datasets
      .previewSteps(profile.id, JSON.parse(allKey) as PrepStep[], ctrl.signal)
      .then((p) => setFailing(!p.ok && typeof p.step === "number" ? { step: p.step, error: p.error ?? "" } : null))
      .catch(() => undefined);
    return () => ctrl.abort();
  }, [profile.id, allKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (form) setForm(null);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [form, onClose]);

  const columns = preview?.columns ?? [];
  // Colonne sélectionnée, telle qu'elle existe avant l'étape en cours de réglage.
  const selected = (form && before ? before.columns : columns).find((c) => c.name === column);
  const start = (kind: PrepKind) => setForm({ index: null, step: defaultStep(kind, selected, (form ? before : preview)?.columns ?? columns) });

  const submit = () => {
    if (!form) return;
    if (form.index === null) {
      const index = at + 1;
      setSteps((cur) => [...cur.slice(0, index), form.step, ...cur.slice(index)]);
      setAt(index);
    } else {
      const index = form.index;
      setSteps((cur) => cur.map((s, i) => (i === index ? form.step : s)));
      setAt(index);
    }
    if (form.step.kind === "rename" && column === form.step.column) setColumn(form.step.to.trim());
    setForm(null);
  };

  const remove = (index: number) => {
    setSteps((cur) => cur.filter((_, i) => i !== index));
    setAt((a) => (a >= index ? a - 1 : a));
    setForm(null);
  };

  const apply = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await api.datasets.saveSteps(profile.id, steps);
      setProfile(updated);
      datasetChanged(profile.id);
      onSaved?.(updated);
      onClose();
    } catch (e) {
      const detail = (e as { detail?: { issues?: ModelIssue[] } }).detail;
      setError(detail?.issues?.map((i) => `${i.name} : ${i.error}`).join(" ; ") ?? (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3" onMouseDown={(e) => e.target === e.currentTarget && !dirty && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="atelier-pop flex h-[min(52rem,96vh)] w-full max-w-7xl flex-col rounded-xl border border-border bg-surface text-fg shadow-2xl">
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Wand2 className="size-4 text-accent-ink" aria-hidden />
          <h2 id={titleId} className="flex-1 text-sm font-semibold">
            Préparer les données · {profile.name}
          </h2>
          <button type="button" onClick={onClose} aria-label="Fermer" className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg">
            <X className="size-4" aria-hidden />
          </button>
        </header>

        <div className="grid min-h-0 flex-1 grid-cols-[16rem_minmax(0,1fr)]">
          <aside className="flex min-h-0 flex-col border-r border-border" aria-label="Étapes appliquées">
            <p className="px-3 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted">Étapes appliquées</p>
            <ol className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-2">
              <li>
                <button
                  type="button"
                  onClick={() => {
                    setAt(-1);
                    setForm(null);
                  }}
                  aria-current={at === -1 && !form ? "step" : undefined}
                  className={clsx("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs", at === -1 ? "bg-accent-soft" : "hover:bg-accent-faint")}
                >
                  <Database className="size-3.5 shrink-0 text-accent-ink" aria-hidden />
                  <span className="flex-1 font-medium">Source</span>
                </button>
              </li>
              {steps.map((s, i) => {
                const broken = failing?.step === i;
                const after = failing !== null && i > failing.step;
                return (
                  <li key={i} className="group/step">
                    <div className={clsx("flex items-start gap-1 rounded-md px-2 py-1.5 text-xs", at === i ? "bg-accent-soft" : "hover:bg-accent-faint", after && "opacity-50")}>
                      <button
                        type="button"
                        onClick={() => {
                          setAt(i);
                          setForm(null);
                        }}
                        aria-current={at === i ? "step" : undefined}
                        className="min-w-0 flex-1 text-left"
                        title={broken ? failing?.error : describeStep(s)}
                      >
                        <span className="flex items-center gap-1 font-medium">
                          {broken && <TriangleAlert className="size-3.5 shrink-0 text-negative" aria-label="Étape en erreur" />}
                          {i + 1}. {STEP_LABELS[s.kind]}
                        </span>
                        <span className="block truncate text-[11px] text-muted">{describeStep(s)}</span>
                      </button>
                      <button type="button" onClick={() => setForm({ index: i, step: s })} aria-label={`Modifier l'étape ${i + 1}`} className="rounded p-0.5 text-muted opacity-0 hover:text-fg focus:opacity-100 group-hover/step:opacity-100">
                        <Pencil className="size-3" aria-hidden />
                      </button>
                      <button type="button" onClick={() => remove(i)} aria-label={`Supprimer l'étape ${i + 1}`} className="rounded p-0.5 text-muted opacity-0 hover:text-negative focus:opacity-100 group-hover/step:opacity-100">
                        <X className="size-3" aria-hidden />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ol>
            <p className="border-t border-border px-3 py-2 text-[11px] leading-snug text-muted">
              Les étapes sont rejouées sur la source à chaque actualisation. Une nouvelle étape s'insère après celle affichée.
            </p>
          </aside>

          <section className="flex min-h-0 min-w-0 flex-col gap-3 p-3" aria-label="Aperçu">
            <div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label="Transformations">
              {ACTIONS.map(({ kind, icon: Icon, column: needsColumn }) => (
                <button
                  key={kind}
                  type="button"
                  disabled={needsColumn && !selected}
                  onClick={() => start(kind)}
                  title={needsColumn && !selected ? "Sélectionnez d'abord une colonne (clic sur son en-tête)" : undefined}
                  className={clsx(
                    "flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] font-medium disabled:opacity-40",
                    form?.index === null && form.step.kind === kind ? "border-accent-ink bg-accent-soft text-accent-ink" : "border-border hover:bg-accent-faint",
                  )}
                >
                  <Icon className="size-3.5 text-accent-ink" aria-hidden /> {STEP_LABELS[kind]}
                </button>
              ))}
            </div>

            {form && (
              <StepForm
                key={`${form.index ?? "new"}-${form.step.kind}`}
                step={form.step}
                columns={before?.columns ?? columns}
                editing={form.index !== null}
                onChange={(step) => setForm((f) => (f ? { ...f, step } : f))}
                onSubmit={submit}
                onCancel={() => setForm(null)}
              />
            )}

            <div className="flex items-center gap-2 text-xs text-muted" role="status" aria-live="polite">
              {loading && <Loader2 className="size-3 animate-spin" aria-hidden />}
              {preview && (
                <span>
                  {formatCount(preview.rows)} ligne{preview.rows > 1 ? "s" : ""}
                  {preview.rows !== preview.raw_rows && ` sur ${formatCount(preview.raw_rows)} dans la source`} · {formatCount(preview.columns.length)} colonnes
                  {form ? " · aperçu avec l'étape en cours" : at >= 0 ? ` · après l'étape ${at + 1}` : " · source"}
                </span>
              )}
              {preview && !preview.ok && (
                <span className="flex items-center gap-1 text-negative">
                  <TriangleAlert className="size-3.5" aria-hidden /> {preview.error}
                </span>
              )}
              {!selected && <span className="ml-auto">Cliquez sur l'en-tête d'une colonne pour la transformer.</span>}
            </div>

            <div className="atelier-card min-h-0 flex-1 overflow-auto rounded-lg border border-border">
              <table className="w-full border-collapse text-xs">
                <thead className="sticky top-0 z-10 bg-surface">
                  <tr>
                    {columns.map((c) => {
                      const { icon: Icon, label } = TYPE_META[c.type];
                      const on = c.name === column;
                      return (
                        <th key={c.name} scope="col" aria-sort={undefined} className={clsx("border-b border-border p-0 font-medium", on && "bg-accent-soft")}>
                          <button
                            type="button"
                            onClick={() => setColumn(on ? null : c.name)}
                            aria-pressed={on}
                            title={`${label} · ${formatCount(c.distinct)} valeurs distinctes · ${formatCount(c.nulls)} vides`}
                            className={clsx("flex w-full items-center gap-1.5 whitespace-nowrap px-3 py-2 text-left", on ? "text-fg" : "text-muted hover:text-fg")}
                          >
                            <Icon className="size-3.5 shrink-0 text-accent-ink" aria-label={label} />
                            {c.name}
                            {c.nulls > 0 && <span className="text-[10px] font-normal text-muted">({formatCount(c.nulls)} vides)</span>}
                          </button>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {(preview?.sample ?? []).map((row, i) => (
                    <tr key={i} className="border-b border-border/60">
                      {columns.map((c) => {
                        const v = row[c.name];
                        return (
                          <td key={c.name} className={clsx("whitespace-nowrap px-3 py-1.5", c.type === "number" && "text-right tabular-nums", c.name === column && "bg-accent-faint", (v === null || v === undefined) && "italic text-muted")}>
                            {v === null || v === undefined ? "vide" : formatValue(v, c.type)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        {error && (
          <p role="alert" className="mx-4 mb-2 rounded-md bg-negative/10 px-2.5 py-2 text-xs text-negative">
            {error}
          </p>
        )}
        <footer className="flex items-center gap-2 border-t border-border px-4 py-3">
          <span className="text-[11px] text-muted">
            {steps.length} étape{steps.length > 1 ? "s" : ""}
            {dirty ? " · modifications non appliquées" : ""}
          </span>
          <span className="ml-auto" />
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-fg">
            Annuler
          </button>
          <button
            type="button"
            disabled={!dirty || saving || !!form || failing !== null}
            onClick={() => void apply()}
            title={failing ? `L'étape ${failing.step + 1} est en erreur : ${failing.error}` : undefined}
            className="atelier-btn-primary flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-40"
          >
            {saving && <Loader2 className="size-3.5 animate-spin" aria-hidden />} Appliquer
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
