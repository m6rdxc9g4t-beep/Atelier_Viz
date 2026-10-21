import clsx from "clsx";
import { Check, Link2, Loader2, Pencil, Plus, Trash2, TriangleAlert, X } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { datasetChanged, getProfile, setProfile } from "../hooks/useDatasetProfiles";
import { api } from "../lib/api";
import type { DatasetModel, DatasetProfile, DatasetSummary, ModelIssue, Relation, RelationCheck } from "../types/dataset";
import { checkMessages, relationName, relationSummary, suggestRelation } from "./relations";

const field = "w-full rounded-md border border-border bg-field px-2 py-1.5 text-xs outline-none focus:border-focus";
const label = "mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted";

interface Props {
  profile: DatasetProfile;
  /** Jeux disponibles (cibles possibles). */
  datasets: DatasetSummary[];
  onClose: () => void;
  /** Profil enregistré (le Studio et la page Données le reprennent). */
  onSaved?: (profile: DatasetProfile) => void;
}

/**
 * Relations d'un jeu (plusieurs-à-un) : chaque relation reprend des colonnes d'un autre jeu sous
 * `<relation>.<colonne>`, utilisables comme les autres ; les segments du jeu lié filtrent celui-ci.
 */
export function RelationsDialog({ profile, datasets, onClose, onSaved }: Props) {
  const titleId = useId();
  const model: DatasetModel = profile.model ?? { columns: [], measures: [] };
  const relations = model.relations ?? [];
  const [editing, setEditing] = useState<{ index: number | null; draft: Relation } | null>(relations.length ? null : { index: null, draft: emptyDraft() });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const targets = datasets.filter((d) => d.id !== profile.id);
  const takenNames = useMemo(() => relations.filter((_, j) => j !== editing?.index).map((r) => r.name), [relations, editing?.index]);

  function emptyDraft(): Relation {
    return { name: "", dataset_id: "", from_column: "", to_column: "", columns: null };
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const save = async (next: Relation[]) => {
    setSaving(true);
    setError(null);
    try {
      const updated = await api.datasets.saveModel(profile.id, { ...model, relations: next });
      setProfile(updated);
      datasetChanged(profile.id);
      onSaved?.(updated);
      setEditing(null);
      return true;
    } catch (e) {
      const detail = (e as { detail?: { issues?: ModelIssue[] } }).detail;
      setError(detail?.issues?.map((i) => `${i.name} : ${i.error}`).join(" ; ") ?? (e as Error).message);
      return false;
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onClose();
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="atelier-pop flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-border bg-surface text-fg shadow-2xl">
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Link2 className="size-4 text-accent-ink" aria-hidden />
          <h2 id={titleId} className="flex-1 text-sm font-semibold">
            Relations · {profile.name}
          </h2>
          <button type="button" onClick={onClose} aria-label="Fermer" className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg">
            <X className="size-4" aria-hidden />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
          <p className="text-xs leading-relaxed text-muted">
            Une relation relie chaque ligne de ce jeu à <strong className="font-medium text-fg">une</strong> ligne d'un autre jeu (par ex. une vente → sa région). Les
            colonnes reprises apparaissent sous le nom de la relation, et un segment posé sur l'autre jeu filtre aussi celui-ci.
          </p>

          {relations.length > 0 && (
            <ul className="divide-y divide-border rounded-lg border border-border" aria-label="Relations existantes">
              {relations.map((r, i) => (
                <li key={r.name} className={clsx("flex items-center gap-2 px-3 py-2 text-xs", editing?.index === i && "bg-accent-faint")}>
                  <Link2 className="size-3.5 shrink-0 text-accent-ink" aria-hidden />
                  <span className="font-medium">{r.name}</span>
                  <span className="min-w-0 flex-1 truncate text-muted">{relationSummary(r, datasets)}</span>
                  <span className="shrink-0 text-[11px] text-muted">{r.columns ? `${r.columns.length} col.` : "toutes les colonnes"}</span>
                  <button
                    type="button"
                    onClick={() => setEditing({ index: i, draft: { ...r } })}
                    aria-label={`Modifier la relation ${r.name}`}
                    className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg"
                  >
                    <Pencil className="size-3.5" aria-hidden />
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void save(relations.filter((_, j) => j !== i))}
                    aria-label={`Supprimer la relation ${r.name}`}
                    className="rounded p-1 text-muted hover:bg-surface-2 hover:text-negative"
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {editing ? (
            <RelationForm
              key={editing.index ?? "new"}
              profile={profile}
              targets={targets}
              initial={editing.draft}
              takenNames={takenNames}
              saving={saving}
              onCancel={relations.length ? () => setEditing(null) : onClose}
              onSave={(rel) => void save(editing.index === null ? [...relations, rel] : relations.map((r, j) => (j === editing.index ? rel : r)))}
            />
          ) : targets.length ? (
            <button
              type="button"
              onClick={() => setEditing({ index: null, draft: emptyDraft() })}
              className="flex items-center gap-1 text-xs font-medium text-accent-ink hover:underline"
            >
              <Plus className="size-3.5" aria-hidden /> Nouvelle relation
            </button>
          ) : null}
          {!targets.length && <p className="text-xs text-muted">Importez un second jeu de données (par ex. une table de régions ou de produits) pour créer une relation.</p>}

          {error && (
            <p role="alert" className="rounded-md bg-negative/10 px-2.5 py-2 text-xs text-negative">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface FormProps {
  profile: DatasetProfile;
  targets: DatasetSummary[];
  initial: Relation;
  takenNames: string[];
  saving: boolean;
  onCancel: () => void;
  onSave: (rel: Relation) => void;
}

function RelationForm({ profile, targets, initial, takenNames, saving, onCancel, onSave }: FormProps) {
  const [draft, setDraft] = useState<Relation>(initial);
  const [target, setTarget] = useState<DatasetProfile | null>(null);
  const [check, setCheck] = useState<RelationCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const own = profile.columns.filter((c) => !c.calculated && !c.related && !c.measure);
  const set = (patch: Partial<Relation>) => setDraft((d) => ({ ...d, ...patch }));

  // Profil du jeu cible ; une nouvelle cible propose des colonnes correspondantes.
  useEffect(() => {
    if (!draft.dataset_id) {
      setTarget(null);
      return;
    }
    let alive = true;
    getProfile(draft.dataset_id)
      .then((t) => {
        if (!alive) return;
        setTarget(t);
        setDraft((d) => {
          if (d.dataset_id !== t.id || (d.from_column && d.to_column && t.columns.some((c) => c.name === d.to_column))) return d;
          const s = suggestRelation(profile, t);
          return { ...d, from_column: s.from_column, to_column: s.to_column, columns: null, name: d.name || relationName(t.name, takenNames) };
        });
      })
      .catch(() => alive && setTarget(null));
    return () => {
      alive = false;
    };
  }, [draft.dataset_id, profile, takenNames]);

  // Diagnostic des clés à chaque changement (300 ms).
  const ready = !!(draft.dataset_id && draft.from_column && draft.to_column && target);
  useEffect(() => {
    if (!ready) {
      setCheck(null);
      return;
    }
    const ctrl = new AbortController();
    setChecking(true);
    const t = setTimeout(() => {
      api.datasets
        .checkRelation(profile.id, { ...draft, name: draft.name || "lien" }, ctrl.signal)
        .then(setCheck)
        .catch((e: unknown) => (e as Error).name !== "AbortError" && setCheck({ ok: false, error: (e as Error).message, rows: 0, matched: 0, duplicates: 0, unmatched_sample: [] }))
        .finally(() => setChecking(false));
    }, 300);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
    // Seules les clés comptent pour le diagnostic.
  }, [ready, draft.dataset_id, draft.from_column, draft.to_column, profile.id]);

  const targetColumns = useMemo(() => (target?.columns ?? []).filter((c) => !c.measure), [target]);
  const picked = draft.columns ?? targetColumns.map((c) => c.name);
  const togglePicked = (name: string) => {
    const next = picked.includes(name) ? picked.filter((n) => n !== name) : [...picked, name];
    set({ columns: next.length === targetColumns.length ? null : targetColumns.map((c) => c.name).filter((n) => next.includes(n)) });
  };
  const name = draft.name.trim();
  const nameError = !name ? null : name.includes(".") ? "Pas de point dans le nom." : takenNames.includes(name) ? "Nom déjà utilisé." : null;
  const canSave = ready && !!name && !nameError && picked.length > 0 && !!check?.ok && !checking && !saving;
  const messages = check && target ? checkMessages(check, target.name) : [];

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) onSave({ ...draft, name });
      }}
      className="atelier-card space-y-3 rounded-lg border border-border p-3"
      aria-label="Relation"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-xs">
          <span className={label}>Jeu lié</span>
          <select aria-label="Jeu lié" value={draft.dataset_id} onChange={(e) => set({ dataset_id: e.target.value, from_column: "", to_column: "", columns: null })} className={field}>
            <option value="">Choisir un jeu…</option>
            {targets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs">
          <span className={label}>Nom de la relation</span>
          <input value={draft.name} onChange={(e) => set({ name: e.target.value })} maxLength={40} placeholder="ex. regions" className={field} aria-invalid={!!nameError} />
          {nameError && <span className="mt-0.5 block text-[11px] text-negative">{nameError}</span>}
        </label>
        <label className="block text-xs">
          <span className={label}>Colonne de « {profile.name} »</span>
          <select aria-label="Colonne de ce jeu" value={draft.from_column} onChange={(e) => set({ from_column: e.target.value })} className={field} disabled={!target}>
            <option value="">—</option>
            {own.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs">
          <span className={label}>Correspond à (dans {target?.name ?? "le jeu lié"})</span>
          <select aria-label="Colonne correspondante" value={draft.to_column} onChange={(e) => set({ to_column: e.target.value })} className={field} disabled={!target}>
            <option value="">—</option>
            {targetColumns
              .filter((c) => !c.calculated && !c.related)
              .map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                  {c.distinct === (target?.rows ?? 0) - c.nulls ? " (unique)" : ""}
                </option>
              ))}
          </select>
        </label>
      </div>

      <div role="status" aria-live="polite" className="min-h-5 space-y-1 text-xs">
        {checking && (
          <p className="flex items-center gap-1.5 text-muted">
            <Loader2 className="size-3 animate-spin" aria-hidden /> Vérification des correspondances…
          </p>
        )}
        {!checking &&
          messages.map((m) => (
            <p key={m.text} className={clsx("flex items-start gap-1.5", m.tone === "ok" ? "text-positive" : m.tone === "warn" ? "text-fg" : "text-negative")}>
              {m.tone === "ok" ? (
                <Check className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              ) : (
                <TriangleAlert className={clsx("mt-0.5 size-3.5 shrink-0", m.tone === "warn" ? "text-accent-ink" : "")} aria-hidden />
              )}
              {m.text}
            </p>
          ))}
      </div>

      {target && (
        <fieldset>
          <legend className={label}>
            Colonnes reprises ({picked.length}/{targetColumns.length}) — sous « {name || "relation"}.colonne »
          </legend>
          <div className="flex flex-wrap gap-1">
            {targetColumns.map((c) => (
              <label
                key={c.name}
                className={clsx(
                  "flex cursor-pointer items-center gap-1 rounded border px-1.5 py-0.5 text-[11px]",
                  picked.includes(c.name) ? "border-accent-ink bg-accent-soft" : "border-border text-muted hover:bg-accent-faint",
                )}
              >
                <input type="checkbox" checked={picked.includes(c.name)} onChange={() => togglePicked(c.name)} className="sr-only" />
                {picked.includes(c.name) && <Check className="size-3 text-accent-ink" aria-hidden />}
                {c.name}
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded-md px-3 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-fg">
          Annuler
        </button>
        <button type="submit" disabled={!canSave} className="atelier-btn-primary flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-40">
          {saving && <Loader2 className="size-3.5 animate-spin" aria-hidden />} Enregistrer la relation
        </button>
      </div>
    </form>
  );
}
