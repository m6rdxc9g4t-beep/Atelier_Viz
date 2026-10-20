import clsx from "clsx";
import { Bell, BellOff, BellRing, CircleAlert, History, Loader2, Pencil, Play, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { onDatasetRefreshed } from "../../hooks/useDataVersions";
import { api } from "../../lib/api";
import type { Alert, AlertInput } from "../../types/alert";
import type { DatasetSummary } from "../../types/dataset";
import { AlertEditor } from "./AlertEditor";
import { STATUS_TEXT, alertStatus, conditionLabel, filterLabel, formatAlertNumber } from "./alerts";
import { whenLabel } from "./schedule";

const STATUS_ICON = { fired: BellRing, ok: ShieldCheck, never: Bell, error: CircleAlert, off: BellOff };
const STATUS_TONE = { fired: "text-negative", ok: "text-positive", never: "text-muted", error: "text-negative", off: "text-muted" };
const TRIGGER = { refresh: "après actualisation", manual: "à la demande", created: "à la création" };

/** Écran « Alertes » : liste, état, évaluation à la demande, historique ; création et modification. */
export function AlertsSection() {
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [editor, setEditor] = useState<{ initial: AlertInput; editing: Alert | null } | null>(null);
  const [historyOf, setHistoryOf] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([api.alerts.list(), api.datasets.list()])
      .then(([list, ds]) => {
        setAlerts(list);
        setDatasets(ds);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    load();
    return onDatasetRefreshed(load); // évaluées après actualisation : état à jour
  }, [load]);

  const replace = (a: Alert) => setAlerts((list) => (list?.some((x) => x.id === a.id) ? list.map((x) => (x.id === a.id ? a : x)) : [...(list ?? []), a]));
  const nameOf = (id: string) => datasets.find((d) => d.id === id)?.name ?? "jeu supprimé";

  const evaluate = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      replace(await api.alerts.evaluate(id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    try {
      await api.alerts.remove(id);
      setAlerts((list) => list?.filter((a) => a.id !== id) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setConfirmDelete(null);
  };

  const first = datasets[0];
  return (
    <section className="atelier-card rounded-xl border border-border bg-surface" aria-labelledby="alerts-title">
      <header className="flex items-center gap-2 border-b border-border px-5 py-3">
        <BellRing className="size-4 text-accent-ink" aria-hidden />
        <h2 id="alerts-title" className="flex-1 text-sm font-semibold">
          Alertes sur seuil
        </h2>
        <button
          type="button"
          disabled={!first}
          onClick={() =>
            first &&
            setEditor({
              initial: { name: "", dataset_id: first.id, measure: { field: null, agg: "count" }, filters: [], comparison: "gt", threshold: 0, enabled: true, notify: true, webhook: null },
              editing: null,
            })
          }
          className="atelier-btn-primary flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg hover:brightness-110 disabled:opacity-40"
        >
          <Plus className="size-3.5" aria-hidden /> Nouvelle alerte
        </button>
      </header>
      <p className="px-5 pt-3 text-xs text-muted">
        Une alerte surveille une mesure (somme, moyenne, mesure calculée…) sur un jeu, éventuellement filtré. Elle prévient dans l'application et / ou appelle un webhook quand le seuil est franchi. Astuce : depuis un visuel KPI ou une jauge du Studio, l'icône cloche pré-remplit l'alerte.
      </p>
      {error && (
        <p role="alert" className="px-5 pt-2 text-xs text-negative">
          {error}
        </p>
      )}
      {!alerts ? (
        <div className="p-5">
          <Loader2 className="size-4 animate-spin text-muted" aria-label="Chargement" />
        </div>
      ) : alerts.length === 0 ? (
        <p className="p-5 text-xs text-muted">{first ? "Aucune alerte pour l'instant." : "Importez d'abord un jeu de données."}</p>
      ) : (
        <ul className="divide-y divide-border p-2">
          {alerts.map((a) => {
            const status = alertStatus(a);
            const Icon = STATUS_ICON[status];
            return (
              <li key={a.id} className="px-3 py-2.5">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span className={clsx("flex w-32 shrink-0 items-center gap-1.5 text-xs font-medium", STATUS_TONE[status])}>
                    <Icon className="size-4" aria-hidden /> {STATUS_TEXT[status]}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{a.name}</span>
                    <span className="block truncate text-[11px] text-muted">
                      {nameOf(a.dataset_id)} · {conditionLabel(a)}
                      {a.filters.length > 0 && ` · ${a.filters.map(filterLabel).join(", ")}`}
                    </span>
                  </span>
                  <span className="w-36 text-right text-xs">
                    <span className="block font-medium tabular-nums">{a.last_value === null ? "—" : formatAlertNumber(a.last_value)}</span>
                    <span className="block text-[11px] text-muted">{a.last_evaluated_at ? whenLabel(a.last_evaluated_at) : "jamais évaluée"}</span>
                  </span>
                  <span className="flex items-center gap-0.5">
                    <span className="mr-1 flex gap-1 text-[10px] text-muted">
                      {a.notify && <span className="rounded border border-border px-1">Notification</span>}
                      {a.webhook && <span className="rounded border border-border px-1">Webhook</span>}
                    </span>
                    <IconButton label="Évaluer maintenant" onClick={() => void evaluate(a.id)} disabled={busy === a.id}>
                      {busy === a.id ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
                    </IconButton>
                    <IconButton label="Historique" pressed={historyOf === a.id} onClick={() => setHistoryOf(historyOf === a.id ? null : a.id)}>
                      <History className="size-3.5" aria-hidden />
                    </IconButton>
                    <IconButton label="Modifier" onClick={() => setEditor({ initial: { ...a }, editing: a })}>
                      <Pencil className="size-3.5" aria-hidden />
                    </IconButton>
                    {confirmDelete === a.id ? (
                      <span className="ml-1 flex items-center gap-2 text-xs">
                        <button type="button" onClick={() => void remove(a.id)} className="font-medium text-negative hover:underline">
                          Supprimer
                        </button>
                        <button type="button" onClick={() => setConfirmDelete(null)} className="text-muted hover:underline">
                          Annuler
                        </button>
                      </span>
                    ) : (
                      <IconButton label="Supprimer" danger onClick={() => setConfirmDelete(a.id)}>
                        <Trash2 className="size-3.5" aria-hidden />
                      </IconButton>
                    )}
                  </span>
                </div>
                {historyOf === a.id && <AlertHistory alert={a} />}
              </li>
            );
          })}
        </ul>
      )}
      {editor && (
        <AlertEditor
          initial={editor.initial}
          editing={editor.editing}
          datasets={datasets}
          onClose={() => setEditor(null)}
          onSaved={(a) => {
            replace(a);
            setEditor(null);
          }}
        />
      )}
    </section>
  );
}

function IconButton({ label, onClick, children, disabled, pressed, danger }: { label: string; onClick: () => void; children: React.ReactNode; disabled?: boolean; pressed?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={clsx("rounded p-1.5 text-muted hover:bg-surface-2 disabled:opacity-40", danger ? "hover:text-negative" : "hover:text-fg", pressed && "text-accent-ink")}
    >
      {children}
    </button>
  );
}

/** Historique des évaluations d'une alerte (le plus récent d'abord). */
function AlertHistory({ alert }: { alert: Alert }) {
  if (!alert.history.length) return <p className="mt-2 pl-36 text-[11px] text-muted">Aucune évaluation.</p>;
  return (
    <table className="mt-2 w-full text-left text-[11px]">
      <caption className="sr-only">Historique de l'alerte {alert.name}</caption>
      <thead className="text-muted">
        <tr className="border-b border-border">
          <th scope="col" className="py-1 pr-2 font-medium">Évaluation</th>
          <th scope="col" className="py-1 pr-2 text-right font-medium">Valeur</th>
          <th scope="col" className="py-1 pr-2 font-medium">Résultat</th>
          <th scope="col" className="py-1 font-medium">Détail</th>
        </tr>
      </thead>
      <tbody>
        {alert.history.slice(0, 15).map((e, i) => (
          <tr key={`${e.at}-${i}`} className="border-b border-border/60 last:border-0">
            <td className="py-1 pr-2 whitespace-nowrap tabular-nums">
              {whenLabel(e.at)} <span className="text-muted">· {TRIGGER[e.trigger]}</span>
            </td>
            <td className="py-1 pr-2 text-right tabular-nums">{e.value === null ? "—" : formatAlertNumber(e.value)}</td>
            <td className={clsx("py-1 pr-2 whitespace-nowrap", e.fired ? "font-medium text-negative" : e.met ? "text-fg" : "text-muted")}>
              {e.fired ? "Déclenchée" : e.met ? "Seuil toujours franchi" : e.error ? "—" : "Condition non remplie"}
            </td>
            <td className="max-w-80 truncate py-1 text-muted" title={[e.error, e.webhook_error].filter(Boolean).join(" · ")}>
              {[e.error, e.webhook_status ? `webhook : HTTP ${e.webhook_status}` : null, e.webhook_error].filter(Boolean).join(" · ")}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
