import clsx from "clsx";
import { CalendarClock, ChevronDown, ChevronRight, CircleAlert, CircleCheck, CircleSlash, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { onDatasetRefreshed } from "../../hooks/useDataVersions";
import { usePreferences } from "../../hooks/usePreferences";
import { api } from "../../lib/api";
import type { ScheduleState } from "../../types/refresh";
import { KIND_META } from "../data/connect/meta";
import { ScheduleEditor } from "./ScheduleEditor";
import { STATUS_LABEL, describeSchedule, scheduleWarning, whenLabel } from "./schedule";

const STATUS_ICON = { success: CircleCheck, error: CircleAlert, skipped: CircleSlash, interrupted: CircleSlash };
const STATUS_TONE = { success: "text-positive", error: "text-negative", skipped: "text-muted", interrupted: "text-negative" };

/** Liste des jeux actualisables : planification, prochaine exécution, dernier résultat ; dépliable pour modifier. */
export function SchedulesSection() {
  const { prefs } = usePreferences();
  const [states, setStates] = useState<ScheduleState[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.refresh
      .list()
      .then((list) => {
        setStates(list);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    load();
    return onDatasetRefreshed(load);
  }, [load]);

  const replace = (s: ScheduleState) => setStates((list) => list?.map((x) => (x.dataset_id === s.dataset_id ? s : x)) ?? null);

  return (
    <section className="atelier-card rounded-xl border border-border bg-surface" aria-labelledby="schedules-title">
      <header className="flex items-center gap-2 border-b border-border px-5 py-3">
        <CalendarClock className="size-4 text-accent-ink" aria-hidden />
        <h2 id="schedules-title" className="flex-1 text-sm font-semibold">
          Actualisations planifiées
        </h2>
      </header>
      <p className="px-5 pt-3 text-xs text-muted">
        Les jeux importés depuis une connexion (SQL, fichier synchronisé, SharePoint) se relisent tout seuls ; les rapports ouverts se mettent à jour. Une seule actualisation à la fois par jeu. Les alertes du jeu sont évaluées après chaque actualisation.
      </p>
      {error && <p className="px-5 pt-2 text-xs text-negative">{error}</p>}
      {!states ? (
        <div className="p-5">
          <Loader2 className="size-4 animate-spin text-muted" aria-label="Chargement" />
        </div>
      ) : states.length === 0 ? (
        <p className="p-5 text-xs text-muted">Aucun jeu actualisable : importez des données depuis Données → « Se connecter à une source ».</p>
      ) : (
        <ul className="divide-y divide-border p-2">
          {states.map((s) => {
            const last = s.runs[0];
            const Icon = last ? STATUS_ICON[last.status] : null;
            const expanded = open === s.dataset_id;
            const warning = scheduleWarning(s, prefs?.online_mode ?? false);
            const KindIcon = KIND_META[s.kind].icon;
            return (
              <li key={s.dataset_id}>
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? null : s.dataset_id)}
                  aria-expanded={expanded}
                  className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 rounded-md px-3 py-2.5 text-left hover:bg-surface-2 sm:grid-cols-[auto_minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto]"
                >
                  {expanded ? <ChevronDown className="size-4 text-muted" aria-hidden /> : <ChevronRight className="size-4 text-muted" aria-hidden />}
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{s.dataset_name}</span>
                    <span className="flex items-center gap-1 truncate text-[11px] text-muted">
                      <KindIcon className="size-3" aria-hidden /> {s.connection_name}
                    </span>
                  </span>
                  <span className={clsx("hidden text-xs sm:block", s.schedule.mode === "off" ? "text-muted" : "text-fg")}>
                    {describeSchedule(s.schedule)}
                    {s.next_run && <span className="block text-[11px] text-muted">prochaine : {whenLabel(s.next_run)}</span>}
                  </span>
                  <span className="hidden text-xs sm:block">
                    {s.running ? (
                      <span className="flex items-center gap-1 text-accent-ink">
                        <Loader2 className="size-3.5 animate-spin" aria-hidden /> En cours
                      </span>
                    ) : last && Icon ? (
                      <span className={clsx("flex items-center gap-1", STATUS_TONE[last.status])}>
                        <Icon className="size-3.5" aria-hidden /> {STATUS_LABEL[last.status]}
                        <span className="text-[11px] text-muted"> · {whenLabel(last.started_at)}</span>
                      </span>
                    ) : (
                      <span className="text-muted">Jamais exécutée</span>
                    )}
                  </span>
                  {warning ? <CircleAlert className="size-4 text-negative" aria-label={warning} /> : <span />}
                </button>
                {expanded && (
                  <div className="px-10 pt-1 pb-4">
                    <ScheduleEditor state={s} onChange={replace} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
