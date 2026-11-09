import { Loader2, MoonStar } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { api } from "../../lib/api";
import type { BackgroundJobState, BackgroundStatus } from "../../types/background";
import { whenLabel } from "./schedule";

const CHOICES = [15, 30, 60, 180, 360, 720];
const SYSTEM_NAME: Record<string, string> = { darwin: "launchd (macOS)", win32: "Planificateur de tâches (Windows)", linux: "minuteur systemd (Linux)" };

/** Bilan lisible du dernier passage de la tâche du système. */
export function backgroundSummary(last: BackgroundStatus): string {
  if (last.status === "never" || !last.last_run_at) return "Pas encore lancée.";
  const when = whenLabel(last.last_run_at);
  if (last.status === "app_open") return `${when} : application ouverte, elle a actualisé elle-même.`;
  if (last.status === "error") return `${when} : erreur — ${last.message ?? "inconnue"}.`;
  if (!last.refreshed && !last.failed && !last.skipped) return `${when} : rien à échéance.`;
  const parts = [
    last.refreshed ? `${last.refreshed} jeu${last.refreshed > 1 ? "x" : ""} actualisé${last.refreshed > 1 ? "s" : ""}` : null,
    last.failed ? `${last.failed} en échec` : null,
    last.skipped ? `${last.skipped} sauté${last.skipped > 1 ? "s" : ""}` : null,
  ].filter(Boolean);
  return `${when} : ${parts.join(", ")}.`;
}

/**
 * Automatisation → « Quand l'application est fermée » : installe une tâche du système qui lance les
 * actualisations planifiées (et leurs alertes) même sans fenêtre ouverte.
 */
export function BackgroundSection() {
  const id = useId();
  const [state, setState] = useState<BackgroundJobState | null>(null);
  const [minutes, setMinutes] = useState(15);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.background.state().then(
      (s) => {
        setState(s);
        if (s.interval_minutes) setMinutes(s.interval_minutes);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, []);

  const apply = async (enabled: boolean, every = minutes) => {
    setBusy(true);
    setError(null);
    try {
      setState(await api.background.apply({ enabled, interval_minutes: every }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="atelier-card rounded-xl border border-border bg-surface" aria-labelledby={`${id}-title`}>
      <header className="flex items-center gap-2 border-b border-line px-5 py-3">
        <MoonStar className="size-4 text-muted" aria-hidden />
        <h2 id={`${id}-title`} className="flex-1 text-sm font-semibold">
          Quand l'application est fermée
        </h2>
        {busy && <Loader2 className="size-4 animate-spin text-muted" aria-hidden />}
      </header>
      <div className="p-5">
        <p className="text-xs text-muted">
          Une tâche du système lance les actualisations planifiées et leurs alertes (notification, e-mail, webhook) même sans fenêtre ouverte. Rien d'autre ne tourne en permanence.
        </p>
        {state && !state.supported && <p className="mt-3 text-xs text-muted">{state.reason}</p>}
        {state?.supported && (
          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs">
            <label className="flex items-center gap-2">
              <input type="checkbox" className="accent-[var(--accent)]" checked={state.installed} disabled={busy} onChange={(e) => void apply(e.target.checked)} />
              Actualiser en arrière-plan
            </label>
            <label className="flex items-center gap-2 text-muted">
              toutes les
              <select
                className="rounded-md border border-border bg-field px-2 py-1 text-xs text-fg"
                value={minutes}
                disabled={busy}
                onChange={(e) => {
                  const every = Number(e.target.value);
                  setMinutes(every);
                  if (state.installed) void apply(true, every);
                }}
              >
                {CHOICES.map((m) => (
                  <option key={m} value={m}>
                    {m < 60 ? `${m} min` : `${m / 60} h`}
                  </option>
                ))}
              </select>
            </label>
            <span className="text-muted">{SYSTEM_NAME[state.platform] ?? state.platform}</span>
          </div>
        )}
        {state && <p className="mt-2 text-[11px] text-muted">Dernier passage : {backgroundSummary(state.last)}</p>}
        {error && (
          <p role="alert" className="mt-2 text-xs text-negative">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
