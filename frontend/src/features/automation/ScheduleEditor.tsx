import clsx from "clsx";
import { CircleAlert, CircleCheck, CircleSlash, Clock, Loader2, Play } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { refreshDataset } from "../../hooks/useDatasetProfiles";
import { usePreferences } from "../../hooks/usePreferences";
import { api } from "../../lib/api";
import { formatCount } from "../../lib/format";
import type { RefreshRun, RefreshSchedule, ScheduleState } from "../../types/refresh";
import { STATUS_LABEL, describeSchedule, durationLabel, scheduleError, scheduleWarning, whenLabel } from "./schedule";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Planification d'un jeu actualisable : mode (désactivée, intervalle, quotidienne), « Actualiser
 * maintenant » et journal des dernières exécutions.
 */
export function ScheduleEditor({ state, onChange, compact = false }: { state: ScheduleState; onChange: (s: ScheduleState) => void; compact?: boolean }) {
  const id = useId();
  const { prefs } = usePreferences();
  const [draft, setDraft] = useState<RefreshSchedule>(state.schedule);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(state.schedule), [state.schedule]);

  const invalid = scheduleError(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(state.schedule);
  const warning = scheduleWarning({ ...state, schedule: draft }, prefs?.online_mode ?? false);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      onChange(await api.refresh.set(state.dataset_id, draft));
    } catch (e) {
      setError(message(e));
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    setRunning(true);
    setError(null);
    try {
      await refreshDataset(state.dataset_id).catch(() => undefined); // l'erreur est dans le journal
      onChange(await api.refresh.get(state.dataset_id));
    } catch (e) {
      setError(message(e));
    } finally {
      setRunning(false);
    }
  };

  const field = "rounded-md border border-border bg-bg px-2 py-1 text-xs text-fg";
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label htmlFor={`${id}-mode`} className="flex flex-col gap-1 text-[11px] text-muted">
          Fréquence
          <select
            id={`${id}-mode`}
            value={draft.mode}
            onChange={(e) => setDraft({ ...draft, mode: e.target.value as RefreshSchedule["mode"] })}
            className={field}
          >
            <option value="off">Désactivée</option>
            <option value="interval">Toutes les…</option>
            <option value="daily">Chaque jour à…</option>
          </select>
        </label>
        {draft.mode === "interval" && (
          <>
            <label htmlFor={`${id}-every`} className="flex flex-col gap-1 text-[11px] text-muted">
              Intervalle
              <input
                id={`${id}-every`}
                type="number"
                min={1}
                value={draft.every}
                onChange={(e) => setDraft({ ...draft, every: Number(e.target.value) })}
                className={clsx(field, "w-20 tabular-nums")}
              />
            </label>
            <label htmlFor={`${id}-unit`} className="flex flex-col gap-1 text-[11px] text-muted">
              Unité
              <select id={`${id}-unit`} value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value as RefreshSchedule["unit"] })} className={field}>
                <option value="minutes">minutes</option>
                <option value="hours">heures</option>
              </select>
            </label>
          </>
        )}
        {draft.mode === "daily" && (
          <label htmlFor={`${id}-at`} className="flex flex-col gap-1 text-[11px] text-muted">
            Heure (locale)
            <input id={`${id}-at`} type="time" value={draft.at} onChange={(e) => setDraft({ ...draft, at: e.target.value })} className={clsx(field, "tabular-nums")} />
          </label>
        )}
        <button
          type="button"
          disabled={!dirty || !!invalid || saving}
          onClick={() => void save()}
          className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg hover:brightness-110 disabled:opacity-40"
        >
          {saving ? "Enregistrement…" : "Enregistrer"}
        </button>
        <button
          type="button"
          disabled={running || state.running}
          onClick={() => void runNow()}
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-2 disabled:opacity-50"
        >
          {running || state.running ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
          Actualiser maintenant
        </button>
      </div>

      <p className="flex items-center gap-1.5 text-[11px] text-muted">
        <Clock className="size-3.5" aria-hidden />
        {state.schedule.mode === "off" ? (
          "Pas d'actualisation automatique."
        ) : (
          <>
            {describeSchedule(state.schedule)} · prochaine : <span className="font-medium text-fg">{state.next_run ? whenLabel(state.next_run) : "—"}</span>
          </>
        )}
        {dirty && <span className="text-accent"> (modification non enregistrée)</span>}
      </p>
      {invalid && <p className="text-[11px] text-negative">{invalid}</p>}
      {warning && (
        <p className="flex items-center gap-1.5 text-[11px] text-negative">
          <CircleAlert className="size-3.5" aria-hidden /> {warning}
        </p>
      )}
      {error && (
        <p role="alert" className="text-[11px] text-negative">
          {error}
        </p>
      )}

      <RunLog runs={compact ? state.runs.slice(0, 5) : state.runs} />
    </div>
  );
}

const STATUS_ICON = { success: CircleCheck, error: CircleAlert, skipped: CircleSlash, interrupted: CircleSlash };
const STATUS_TONE = { success: "text-positive", error: "text-negative", skipped: "text-muted", interrupted: "text-negative" };

/** Journal des dernières exécutions (succès / échec / sautée, durée, lignes). */
export function RunLog({ runs }: { runs: RefreshRun[] }) {
  if (!runs.length) return <p className="text-[11px] text-muted">Aucune exécution pour l'instant.</p>;
  return (
    <table className="w-full text-left text-[11px]">
      <caption className="sr-only">Dernières exécutions</caption>
      <thead className="text-muted">
        <tr className="border-b border-border">
          <th scope="col" className="py-1 pr-2 font-medium">Exécution</th>
          <th scope="col" className="py-1 pr-2 font-medium">Statut</th>
          <th scope="col" className="py-1 pr-2 text-right font-medium">Durée</th>
          <th scope="col" className="py-1 pr-4 text-right font-medium">Lignes</th>
          <th scope="col" className="py-1 font-medium">Détail</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => {
          const Icon = STATUS_ICON[r.status];
          return (
            <tr key={`${r.started_at}-${r.trigger}`} className="border-b border-border/60 last:border-0">
              <td className="py-1 pr-2 whitespace-nowrap tabular-nums">
                {whenLabel(r.started_at)} <span className="text-muted">· {r.trigger === "manual" ? "manuelle" : "planifiée"}</span>
              </td>
              <td className={clsx("py-1 pr-2 whitespace-nowrap", STATUS_TONE[r.status])}>
                <span className="flex items-center gap-1">
                  <Icon className="size-3.5" aria-hidden /> {STATUS_LABEL[r.status]}
                </span>
              </td>
              <td className="py-1 pr-2 text-right whitespace-nowrap tabular-nums">{durationLabel(r.duration_ms)}</td>
              <td className="py-1 pr-4 text-right tabular-nums">{r.rows === null ? "—" : formatCount(r.rows)}</td>
              <td className="max-w-72 truncate py-1 text-muted" title={r.message ?? ""}>
                {r.message ?? ""}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
