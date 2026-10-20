import { BellPlus, Loader2, Plus, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";

import { getProfile } from "../../hooks/useDatasetProfiles";
import { usePreferences } from "../../hooks/usePreferences";
import { api } from "../../lib/api";
import type { Alert, AlertInput, Comparison } from "../../types/alert";
import type { DatasetProfile, DatasetSummary } from "../../types/dataset";
import type { Agg, Filter, FilterOp } from "../../types/query";
import { AGG_LABELS, aggsFor } from "../../visuals/fields";
import { COMPARISONS, alertError, filterLabel, formatAlertNumber, parseFilterValues } from "./alerts";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const field = "rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-fg";
const FILTER_OPS: { value: FilterOp; label: string }[] = [
  { value: "in", label: "est parmi (séparés par ;)" },
  { value: "eq", label: "=" },
  { value: "neq", label: "≠" },
  { value: "gt", label: ">" },
  { value: "gte", label: "≥" },
  { value: "lt", label: "<" },
  { value: "lte", label: "≤" },
  { value: "contains", label: "contient" },
];

/**
 * Création / modification d'une alerte : jeu, mesure (agrégat d'un champ ou mesure calculée),
 * filtres, condition, seuil, actions (notification, webhook). Valeur actuelle calculée par le moteur.
 */
export function AlertEditor({
  initial,
  editing,
  datasets,
  onClose,
  onSaved,
}: {
  initial: AlertInput;
  editing?: Alert | null;
  datasets: DatasetSummary[];
  onClose: () => void;
  onSaved: (a: Alert) => void;
}) {
  const titleId = useId();
  const { prefs } = usePreferences();
  const [draft, setDraft] = useState<AlertInput>(initial);
  const [profile, setProfile] = useState<DatasetProfile | undefined>();
  const [current, setCurrent] = useState<{ value: number | null; error: string | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filterDraft, setFilterDraft] = useState<{ field: string; op: FilterOp; raw: string } | null>(null);

  useEffect(() => {
    let alive = true;
    getProfile(draft.dataset_id)
      .then((p) => alive && setProfile(p))
      .catch(() => alive && setProfile(undefined));
    return () => {
      alive = false;
    };
  }, [draft.dataset_id]);

  // Valeur actuelle de la mesure (moteur de requêtes, mêmes filtres).
  const key = JSON.stringify([draft.dataset_id, draft.measure, draft.filters]);
  useEffect(() => {
    const ctl = new AbortController();
    const t = setTimeout(() => {
      api
        .query({ dataset_id: draft.dataset_id, measures: [draft.measure], filters: draft.filters, limit: 1 }, ctl.signal)
        .then((res) => {
          const v = res.rows[0]?.[0];
          setCurrent({ value: typeof v === "number" ? v : null, error: null });
        })
        .catch((e: unknown) => !ctl.signal.aborted && setCurrent({ value: null, error: message(e) }));
    }, 250);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const invalid = alertError(draft, profile);
  const fieldType = draft.measure.agg === "calc" ? "number" : profile?.columns.find((c) => c.name === draft.measure.field)?.type;
  const measures = profile?.model?.measures ?? [];

  const setMeasureField = (value: string) => {
    if (value === "") return setDraft({ ...draft, measure: { field: null, agg: "count" } });
    if (value.startsWith("calc:")) return setDraft({ ...draft, measure: { field: value.slice(5), agg: "calc" } });
    const type = profile?.columns.find((c) => c.name === value)?.type;
    const aggs = aggsFor(type);
    const agg: Agg = aggs.includes(draft.measure.agg) ? draft.measure.agg : (aggs[0] ?? "count");
    setDraft({ ...draft, measure: { field: value, agg } });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    const body: AlertInput = { ...draft, name: draft.name.trim(), webhook: draft.webhook ? { ...draft.webhook, url: draft.webhook.url.trim() } : null };
    try {
      onSaved(editing ? await api.alerts.update(editing.id, body) : await api.alerts.create(body));
    } catch (e) {
      setError(message(e));
      setSaving(false);
    }
  };

  const addFilter = () => {
    if (!filterDraft?.field || !filterDraft.raw.trim()) return;
    const column = profile?.columns.find((c) => c.name === filterDraft.field);
    const values = parseFilterValues(filterDraft.raw, column, filterDraft.op);
    const f: Filter = { field: filterDraft.field, op: filterDraft.op, values: filterDraft.op === "in" ? values : values.slice(0, 1) };
    setDraft({ ...draft, filters: [...draft.filters, f] });
    setFilterDraft(null);
  };

  const webhookExternal = draft.webhook && !/^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|[^/]*\.local)/i.test(draft.webhook.url.trim());

  // Portail : la boîte peut être ouverte depuis un visuel (parent mis à l'échelle par le zoom) ;
  // les événements ne remontent pas jusqu'au visuel (sélection, glisser).
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="atelier-pop flex max-h-[92vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border bg-surface text-fg shadow-2xl">
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <BellPlus className="size-4 text-accent-ink" aria-hidden />
          <h2 id={titleId} className="flex-1 text-sm font-semibold">
            {editing ? "Modifier l'alerte" : "Nouvelle alerte"}
          </h2>
          <button type="button" onClick={onClose} aria-label="Fermer" className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg">
            <X className="size-4" aria-hidden />
          </button>
        </header>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
          <label className="flex flex-col gap-1 text-[11px] text-muted">
            Nom
            <input autoFocus value={draft.name} maxLength={120} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="CA du mois sous l'objectif" className={field} />
          </label>

          <fieldset className="space-y-2">
            <legend className="mb-1 text-xs font-semibold">Mesure surveillée</legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <label className="flex flex-col gap-1 text-[11px] text-muted">
                Jeu de données
                <select
                  value={draft.dataset_id}
                  onChange={(e) => setDraft({ ...draft, dataset_id: e.target.value, measure: { field: null, agg: "count" }, filters: [] })}
                  className={field}
                  disabled={!!editing}
                >
                  {datasets.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-muted">
                Champ
                <select value={draft.measure.agg === "calc" ? `calc:${draft.measure.field ?? ""}` : (draft.measure.field ?? "")} onChange={(e) => setMeasureField(e.target.value)} className={field}>
                  <option value="">Nombre de lignes</option>
                  {measures.length > 0 && (
                    <optgroup label="Mesures calculées">
                      {measures.map((m) => (
                        <option key={m.name} value={`calc:${m.name}`}>
                          {m.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  <optgroup label="Colonnes">
                    {(profile?.columns ?? []).map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-muted">
                Agrégation
                <select
                  value={draft.measure.agg}
                  disabled={!draft.measure.field || draft.measure.agg === "calc"}
                  onChange={(e) => setDraft({ ...draft, measure: { ...draft.measure, agg: e.target.value as Agg } })}
                  className={field}
                >
                  {(draft.measure.agg === "calc" ? (["calc"] as Agg[]) : draft.measure.field ? aggsFor(fieldType) : (["count"] as Agg[])).map((a) => (
                    <option key={a} value={a}>
                      {AGG_LABELS[a]}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="space-y-1.5">
              <p className="text-[11px] text-muted">Filtres (facultatifs)</p>
              {draft.filters.length > 0 && (
                <ul className="flex flex-wrap gap-1.5">
                  {draft.filters.map((f, i) => (
                    <li key={`${f.field}-${i}`} className="flex items-center gap-1 rounded-full border border-border bg-bg py-0.5 pr-1 pl-2.5 text-[11px]">
                      {filterLabel(f)}
                      <button type="button" aria-label={`Retirer le filtre ${filterLabel(f)}`} onClick={() => setDraft({ ...draft, filters: draft.filters.filter((_, j) => j !== i) })} className="rounded-full p-0.5 text-muted hover:text-negative">
                        <X className="size-3" aria-hidden />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {filterDraft ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <select aria-label="Champ du filtre" value={filterDraft.field} onChange={(e) => setFilterDraft({ ...filterDraft, field: e.target.value })} className={field}>
                    <option value="">Champ…</option>
                    {(profile?.columns ?? []).map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <select aria-label="Opérateur" value={filterDraft.op} onChange={(e) => setFilterDraft({ ...filterDraft, op: e.target.value as FilterOp })} className={field}>
                    {FILTER_OPS.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                  <input aria-label="Valeur du filtre" value={filterDraft.raw} onChange={(e) => setFilterDraft({ ...filterDraft, raw: e.target.value })} onKeyDown={(e) => e.key === "Enter" && addFilter()} placeholder="Valeur" className={`${field} min-w-0 flex-1`} />
                  <button type="button" onClick={addFilter} className="rounded-md border border-border px-2 py-1.5 text-xs hover:bg-surface-2">
                    Ajouter
                  </button>
                </div>
              ) : (
                <button type="button" onClick={() => setFilterDraft({ field: "", op: "in", raw: "" })} className="flex items-center gap-1 text-xs text-accent-ink hover:underline">
                  <Plus className="size-3.5" aria-hidden /> Ajouter un filtre
                </button>
              )}
            </div>
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="mb-1 text-xs font-semibold">Condition</legend>
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1 text-[11px] text-muted">
                Se déclenche quand la mesure est
                <select value={draft.comparison} onChange={(e) => setDraft({ ...draft, comparison: e.target.value as Comparison })} className={field}>
                  {COMPARISONS.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.symbol} {c.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-[11px] text-muted">
                Seuil
                <input type="number" step="any" value={Number.isFinite(draft.threshold) ? draft.threshold : ""} onChange={(e) => setDraft({ ...draft, threshold: e.target.value === "" ? Number.NaN : Number(e.target.value) })} className={`${field} w-36 tabular-nums`} />
              </label>
              <p className="pb-1.5 text-[11px] text-muted" aria-live="polite">
                Valeur actuelle :{" "}
                {current === null ? (
                  <Loader2 className="inline size-3 animate-spin" aria-label="Calcul" />
                ) : current.error ? (
                  <span className="text-negative">{current.error}</span>
                ) : (
                  <span className="font-medium text-fg tabular-nums">{current.value === null ? "—" : formatAlertNumber(current.value)}</span>
                )}
              </p>
            </div>
            <p className="text-[11px] text-muted">
              Évaluée après chaque actualisation du jeu et à la demande. Elle se déclenche au <strong className="font-medium text-fg">franchissement</strong> du seuil, pas à chaque évaluation où il reste dépassé.
            </p>
          </fieldset>

          <fieldset className="space-y-2">
            <legend className="mb-1 text-xs font-semibold">Actions</legend>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={draft.notify} onChange={(e) => setDraft({ ...draft, notify: e.target.checked })} className="accent-[var(--accent)]" />
              Notification dans l'application
            </label>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={draft.webhook !== null}
                onChange={(e) => setDraft({ ...draft, webhook: e.target.checked ? { url: "http://localhost:5678/webhook/alerte", method: "POST" } : null })}
                className="accent-[var(--accent)]"
              />
              Appeler un webhook (n8n, Make, Zapier…)
            </label>
            {draft.webhook && (
              <div className="flex gap-2 pl-6">
                <input aria-label="Adresse du webhook" value={draft.webhook.url} onChange={(e) => draft.webhook && setDraft({ ...draft, webhook: { ...draft.webhook, url: e.target.value } })} className={`${field} min-w-0 flex-1`} />
                <select aria-label="Méthode" value={draft.webhook.method} onChange={(e) => draft.webhook && setDraft({ ...draft, webhook: { ...draft.webhook, method: e.target.value as "GET" | "POST" } })} className={field}>
                  <option value="POST">POST</option>
                  <option value="GET">GET</option>
                </select>
              </div>
            )}
            {webhookExternal && !prefs?.online_mode && (
              <p className="pl-6 text-[11px] text-negative">Hors ligne, seules les adresses locales sont appelées : passez « En ligne » pour un service sur Internet.</p>
            )}
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={draft.enabled} onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })} className="accent-[var(--accent)]" />
              Alerte active
            </label>
          </fieldset>
        </div>

        <footer className="flex items-center gap-2 border-t border-border px-4 py-3">
          <p className="min-w-0 flex-1 truncate text-[11px] text-negative" role="alert">
            {error ?? (draft.name.trim() ? invalid : null)}
          </p>
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-fg">
            Annuler
          </button>
          <button type="button" disabled={!!invalid || saving} onClick={() => void save()} className="btn-signature rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg hover:brightness-110 disabled:opacity-40">
            {saving ? "Enregistrement…" : editing ? "Enregistrer" : "Créer l'alerte"}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
