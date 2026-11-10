import { ExternalLink, Loader2, Trash2, Wand2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { api } from "../../lib/api";
import { openExternal } from "../../lib/desktop";
import { APP_LABELS, THIS_APP, pickHistoire, readRemembered, remember, stepsAround } from "../../lib/exemples";
import { navigate } from "../../lib/router";
import { suiteApps } from "../../lib/suite";
import { storyPages } from "../../studio/starter";
import type { ExempleHistoire } from "../../types/exemples";
import type { ReportSummary } from "../../types/report";

const euroFmt = new Intl.NumberFormat("fr-FR");

/**
 * « Exemples de la suite » : une histoire fictive suivie d'une app à l'autre. Ici, ses jeux de données (opérations
 * catégorisées, tables de Tab, exports de Convert) et son alerte, qui se déclenche ; on ouvre un rapport de démarrage.
 */
export function SuiteExamples({ reports, onChanged }: { reports: ReportSummary[] | null; onChanged: () => void }) {
  const [histoires, setHistoires] = useState<ExempleHistoire[]>([]);
  const [selected, setSelected] = useState<string | null>(readRemembered());
  const [busy, setBusy] = useState<"load" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => api.exemples.list().then(setHistoires, () => undefined);
  useEffect(() => {
    void refresh();
  }, []);

  const histoire = pickHistoire(histoires, selected);
  const steps = histoire ? stepsAround(histoire) : null;
  const nextUrl = useMemo(() => (steps?.next ? suiteApps().find((a) => a.id === steps.next?.app)?.url : undefined), [steps?.next]);

  if (!histoire || !steps) return null;

  const choose = (id: string) => {
    setSelected(id);
    remember(id);
    setError(null);
  };

  /** Charge les jeux et l'alerte, puis ouvre le rapport d'exemple de l'histoire (créé au premier chargement). */
  const open = async () => {
    setBusy("load");
    setError(null);
    try {
      const res = await api.exemples.load(histoire.id);
      const existing = reports?.find((r) => r.name === res.rapport);
      if (existing) {
        navigate(`/rapports/${existing.id}`);
        return;
      }
      const report = await api.reports.create(res.rapport, res.operations_id);
      // Opérations d'abord, puis les tables métier de l'histoire (contrats, lots, commandes…) : une page chacune.
      const ids = [res.operations_id, ...res.datasets.map((d) => d.id).filter((id) => id !== res.operations_id)];
      const profiles = await Promise.all(ids.map((id) => api.datasets.get(id)));
      await api.reports.save(report.id, { name: res.rapport, dataset_id: res.operations_id, theme: {}, pages: storyPages(histoire.titre, profiles) });
      navigate(`/rapports/${report.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy("remove");
    setError(null);
    try {
      await api.exemples.remove(histoire.id);
      await refresh();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section aria-labelledby="suite-examples-title" className="atelier-card overflow-hidden">
      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0">
            <h2 id="suite-examples-title" className="text-sm font-semibold">
              Exemples de la suite
            </h2>
            <p className="mt-0.5 text-xs text-muted">
              Des histoires fictives qui traversent toute la suite : les relevés convertis par Convert et rangés dans Tab deviennent ici des jeux de données, avec une alerte qui se déclenche.
            </p>
          </div>
          <select
            value={histoire.id}
            onChange={(e) => choose(e.target.value)}
            aria-label="Histoire d'exemple"
            className="h-[30px] w-64 max-w-full rounded-md border border-border bg-field px-2.5 text-sm"
          >
            {histoires.map((h) => (
              <option key={h.id} value={h.id}>
                {h.secteur} · {h.titre}
              </option>
            ))}
          </select>
        </div>

        <div>
          <p className="text-sm font-medium">
            {histoire.titre} <span className="font-normal text-muted">— {histoire.sous_titre}</span>
          </p>
          <p className="mt-1 max-w-3xl text-xs text-muted">{histoire.resume}</p>
        </div>

        <ol className="flex flex-wrap gap-1.5" aria-label="Parcours de l'histoire dans la suite">
          {histoire.parcours.map((e, i) => (
            <li
              key={e.app}
              title={e.texte}
              aria-current={e.app === THIS_APP ? "step" : undefined}
              className={`flex h-[22px] items-center gap-1.5 rounded-md border px-2 text-xs ${e.app === THIS_APP ? "border-accent-ink/40 bg-accent-soft text-accent-ink" : "border-border text-muted"}`}
            >
              <span className="tabular-nums text-faint">{i + 1}</span>
              {APP_LABELS[e.app]}
            </li>
          ))}
        </ol>
        {steps.current && <p className="text-xs">{steps.current.texte}</p>}
        <p className="text-xs text-muted">
          {euroFmt.format(histoire.jeux.length)} jeux : {histoire.jeux.map((j) => j.replace(`${histoire.titre} — `, "")).join(", ")} · alerte « {histoire.alerte} ».
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void open()}
            className="atelier-btn-primary flex h-[30px] items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium disabled:opacity-50"
          >
            {busy === "load" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Wand2 className="size-4" aria-hidden />}
            {histoire.charge ? "Ouvrir le rapport de l'exemple" : "Charger l'exemple"}
          </button>
          {histoire.charge && (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void remove()}
              className="flex h-[30px] items-center justify-center gap-1.5 rounded-md border border-border bg-surface px-3 text-sm font-medium hover:bg-surface-2 disabled:opacity-50"
            >
              {busy === "remove" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Trash2 className="size-4 text-muted" aria-hidden />}
              Retirer l'exemple
            </button>
          )}
        </div>
        {error && (
          <p role="alert" className="text-xs text-negative">
            {error}
          </p>
        )}
      </div>

      {steps.next && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-3 text-xs">
          <p className="min-w-0 text-muted">
            <span className="font-medium text-fg">Ensuite, {APP_LABELS[steps.next.app]}</span> — {steps.next.texte}
          </p>
          {nextUrl && (
            <button type="button" onClick={() => openExternal(nextUrl)} className="flex h-[26px] items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted hover:bg-surface-2 hover:text-fg">
              Ouvrir Atelier {APP_LABELS[steps.next.app]}
              <ExternalLink className="size-3.5" aria-hidden />
            </button>
          )}
        </div>
      )}
    </section>
  );
}
