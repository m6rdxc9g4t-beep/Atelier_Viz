import clsx from "clsx";
import { FileBarChart2, Loader2, Plus, Sparkles, Trash2, Wand2 } from "lucide-react";
import { useEffect, useState } from "react";

import { api } from "../../lib/api";
import { onExamplesChange, showExamplesOnHome } from "../../lib/exemples";
import { navigate } from "../../lib/router";
import { starterPages } from "../../studio/starter";
import type { DatasetSummary } from "../../types/dataset";
import type { ReportSummary } from "../../types/report";
import { SuiteExamples } from "./SuiteExamples";

const dateFmt = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short" });

/** Rapport de démonstration construit sur les données d'exemple du dépôt (samples/). */
export const EXAMPLE_REPORT = "Exemple — Ventes 2026";

/** Accueil : rapports existants, création vide ou « rapport de démarrage » généré depuis un jeu de données. */
export function ReportsHome() {
  const [reports, setReports] = useState<ReportSummary[] | null>(null);
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [datasetId, setDatasetId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  // Échecs de la liste : lecture impossible (la liste n'est alors pas « vide ») ou suppression refusée.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const [version, setVersion] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoadError(null);
    Promise.all([api.reports.list(), api.datasets.list()])
      .then(([r, d]) => {
        if (!alive) return;
        setReports(r);
        setDatasets(d);
        setDatasetId((current) => (d.some((x) => x.id === current) ? current : (d[0]?.id ?? "")));
      })
      .catch((e: unknown) => alive && setLoadError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [version]);

  // Histoire chargée ou retirée (ici ou depuis le dialogue de la barre latérale) : rapports et jeux relus.
  useEffect(() => onExamplesChange(() => setVersion((v) => v + 1)), []);

  const create = async (starter: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const ds = datasets.find((d) => d.id === datasetId);
      const report = await api.reports.create(name.trim() || (starter && ds ? `Analyse — ${ds.name}` : "Nouveau rapport"), datasetId || null);
      if (starter && datasetId) {
        const profile = await api.datasets.get(datasetId);
        await api.reports.save(report.id, { name: report.name, dataset_id: datasetId, theme: {}, pages: starterPages(profile) });
      }
      navigate(`/rapports/${report.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const openExample = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.samples.load();
      const ventes = res.datasets.find((d) => d.name === "ventes_2026.csv");
      if (!ventes) throw new Error("Le fichier samples/ventes_2026.csv est introuvable dans le dépôt.");
      const existing = reports?.find((r) => r.name === EXAMPLE_REPORT);
      if (existing) {
        navigate(`/rapports/${existing.id}`);
        return;
      }
      const report = await api.reports.create(EXAMPLE_REPORT, ventes.id);
      const profile = await api.datasets.get(ventes.id);
      await api.reports.save(report.id, { name: EXAMPLE_REPORT, dataset_id: ventes.id, theme: {}, pages: starterPages(profile) });
      navigate(`/rapports/${report.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const remove = async (report: ReportSummary) => {
    setRemoveError(null);
    try {
      await api.reports.remove(report.id);
      setReports((list) => list?.filter((r) => r.id !== report.id) ?? null);
    } catch (e) {
      setRemoveError(`« ${report.name} » n'a pas été supprimé : ${e instanceof Error ? e.message : String(e)}`);
    }
    setConfirm(null);
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 lg:px-8 lg:py-8">
      {reports !== null && (reports.length === 0 || !datasets.length) && (
        <section className="atelier-card flex flex-col gap-4 p-4 sm:flex-row sm:items-center">
          <Wand2 className="size-5 shrink-0 text-muted" aria-hidden />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold">Découvrir avec un exemple</h2>
            <p className="mt-0.5 text-xs text-muted">
              Importe les données d'exemple du dépôt (573 ventes 2026 et 30 magasins) et ouvre un rapport prêt à explorer : filtres, carte, export PowerPoint, IA.
            </p>
          </div>
          <button type="button" disabled={busy} onClick={() => void openExample()} className="atelier-btn-primary flex h-[30px] items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium disabled:opacity-50">
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Wand2 className="size-4" aria-hidden />}
            Ouvrir l'exemple
          </button>
        </section>
      )}
      <section className="atelier-card p-4">
        <h2 className="text-sm font-semibold">Nouveau rapport</h2>
        <p className="mt-0.5 text-xs text-muted">Partez d'une page vide, ou laissez l'application proposer une première mise en page à partir de vos données.</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto]">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom du rapport" aria-label="Nom du rapport" className="h-[34px] rounded-md border border-border bg-field px-3 text-sm" />
          <select value={datasetId} onChange={(e) => setDatasetId(e.target.value)} aria-label="Jeu de données" className="h-[34px] rounded-md border border-border bg-field px-2.5 text-sm">
            {!datasets.length && <option value="">Aucun jeu de données</option>}
            {datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.rows.toLocaleString("fr-FR")} ligne{d.rows > 1 ? "s" : ""})
              </option>
            ))}
          </select>
          <button type="button" disabled={busy} onClick={() => void create(false)} className="flex h-[34px] items-center justify-center gap-1.5 rounded-md border border-border bg-surface px-3 text-sm font-medium hover:bg-surface-2 disabled:opacity-50">
            <Plus className="size-4 text-muted" aria-hidden /> Page vide
          </button>
          <button type="button" disabled={busy || !datasetId} onClick={() => void create(true)} className="atelier-btn-primary flex h-[34px] items-center justify-center gap-1.5 rounded-md px-3 text-sm font-medium disabled:opacity-50">
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Sparkles className="size-4" aria-hidden />}
            Rapport de démarrage
          </button>
        </div>
        {datasets.length > 0 && reports !== null && reports.length > 0 && (
          <p className="mt-3 text-xs text-muted">
            Ou{" "}
            <button type="button" disabled={busy} onClick={() => void openExample()} className="text-accent-ink underline underline-offset-2 disabled:opacity-50">
              ouvrir le rapport d'exemple
            </button>{" "}
            (données du dossier samples/ du dépôt).
          </p>
        )}
        {!datasets.length && (
          <p className="mt-3 text-xs text-muted">
            Importez d'abord un fichier dans{" "}
            <button type="button" onClick={() => navigate("/donnees")} className="text-accent-ink underline underline-offset-2">
              Données
            </button>
            .
          </p>
        )}
        {error && (
          <p role="alert" className="mt-3 text-xs text-negative">
            {error}
          </p>
        )}
      </section>
      {/* Premier lancement (aucun rapport) : les exemples guident. Ensuite ils sont au pied de la barre latérale. */}
      {showExamplesOnHome(reports) && <SuiteExamples reports={reports} />}

      <section aria-labelledby="mes-rapports">
        <h2 id="mes-rapports" className="mb-2 flex items-baseline gap-2 text-sm font-semibold">
          Mes rapports
          {reports !== null && reports.length > 0 && <span className="text-2xs font-medium text-faint tabular-nums">{reports.length}</span>}
        </h2>
        {removeError && (
          <p role="alert" className="mb-2 text-xs text-negative">
            {removeError}
          </p>
        )}
        {loadError && (
          <p role="alert" className="mb-2 text-sm text-negative">
            Les rapports n'ont pas pu être lus : {loadError}{" "}
            <button type="button" onClick={() => setVersion((v) => v + 1)} className="font-medium text-accent-ink underline underline-offset-2">
              Réessayer
            </button>
          </p>
        )}
        {reports === null ? (
          !loadError && <Loader2 className="size-4 animate-spin text-muted" aria-label="Chargement" />
        ) : reports.length === 0 ? (
          <p className="text-sm text-muted">Aucun rapport pour l'instant.</p>
        ) : (
          <ul className="atelier-card overflow-hidden">
            {reports.map((r) => (
              <li key={r.id} className="group relative flex min-h-(--row-h) items-center border-b border-line last:border-b-0 hover:bg-surface-2">
                <button type="button" onClick={() => navigate(`/rapports/${r.id}`)} className={clsx("flex min-h-(--row-h) min-w-0 flex-1 items-center gap-3 py-2 pl-4 text-left outline-offset-[-2px]", confirm === r.id ? "pr-40" : "pr-12")}>
                  <FileBarChart2 className="size-4 shrink-0 text-faint" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{r.name}</span>
                  <span className="hidden shrink-0 text-xs text-muted tabular-nums sm:block">
                    {r.pages} page{r.pages > 1 ? "s" : ""} · {r.visuals} visuel{r.visuals > 1 ? "s" : ""}
                  </span>
                  <span className="hidden w-48 shrink-0 text-right text-xs text-faint tabular-nums md:block">Modifié le {dateFmt.format(new Date(r.updated_at))}</span>
                </button>
                {confirm === r.id ? (
                  <span className="absolute right-2 flex gap-1 text-xs">
                    <button type="button" onClick={() => void remove(r)} className="rounded-md px-1.5 py-1 font-medium text-negative hover:bg-surface-3">
                      Supprimer
                    </button>
                    <button type="button" autoFocus onClick={() => setConfirm(null)} className="rounded-md px-1.5 py-1 text-muted hover:bg-surface-3 hover:text-fg">
                      Annuler
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirm(r.id)}
                    aria-label={`Supprimer ${r.name}`}
                    className="absolute right-2 grid size-7 place-items-center rounded-md text-muted opacity-0 hover:bg-surface-3 hover:text-negative focus:opacity-100 group-hover:opacity-100 pointer-coarse:size-10 pointer-coarse:opacity-100"
                  >
                    <Trash2 className="size-3.5" aria-hidden />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
