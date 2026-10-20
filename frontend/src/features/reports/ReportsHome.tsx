import { FileBarChart2, Loader2, Plus, Sparkles, Trash2, Wand2 } from "lucide-react";
import { useEffect, useState } from "react";

import { api } from "../../lib/api";
import { navigate } from "../../lib/router";
import { starterPages } from "../../studio/starter";
import type { DatasetSummary } from "../../types/dataset";
import type { ReportSummary } from "../../types/report";

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

  useEffect(() => {
    Promise.all([api.reports.list(), api.datasets.list()])
      .then(([r, d]) => {
        setReports(r);
        setDatasets(d);
        setDatasetId(d[0]?.id ?? "");
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

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

  const remove = async (id: string) => {
    await api.reports.remove(id);
    setReports((list) => list?.filter((r) => r.id !== id) ?? null);
    setConfirm(null);
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 lg:p-8">
      {reports !== null && (reports.length === 0 || !datasets.length) && (
        <section className="flex flex-col gap-4 rounded-xl border border-accent-ink/30 bg-accent/5 p-5 sm:flex-row sm:items-center">
          <Wand2 className="size-6 shrink-0 text-accent-ink" aria-hidden />
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold">Découvrir avec un exemple</h2>
            <p className="mt-1 text-xs text-muted">
              Importe les données d'exemple du dépôt (573 ventes 2026 et 30 magasins) et ouvre un rapport prêt à explorer : filtres, carte, export PowerPoint, IA.
            </p>
          </div>
          <button type="button" disabled={busy} onClick={() => void openExample()} className="btn-signature flex items-center justify-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50">
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Wand2 className="size-4" aria-hidden />}
            Ouvrir l'exemple
          </button>
        </section>
      )}
      <section className="atelier-glass rounded-xl border border-border bg-surface p-5">
        <h2 className="text-base font-semibold">Nouveau rapport</h2>
        <p className="mt-1 text-xs text-muted">Partez d'une page vide, ou laissez l'application proposer une première mise en page à partir de vos données.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_1fr_auto_auto]">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom du rapport" aria-label="Nom du rapport" className="rounded-md border border-border bg-bg px-3 py-2 text-sm" />
          <select value={datasetId} onChange={(e) => setDatasetId(e.target.value)} aria-label="Jeu de données" className="rounded-md border border-border bg-bg px-3 py-2 text-sm">
            {!datasets.length && <option value="">Aucun jeu de données</option>}
            {datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} ({d.rows.toLocaleString("fr-FR")} lignes)
              </option>
            ))}
          </select>
          <button type="button" disabled={busy} onClick={() => void create(false)} className="flex items-center justify-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-surface-2 disabled:opacity-50">
            <Plus className="size-4" aria-hidden /> Page vide
          </button>
          <button type="button" disabled={busy || !datasetId} onClick={() => void create(true)} className="btn-signature flex items-center justify-center gap-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-accent-fg disabled:opacity-50">
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Sparkles className="size-4" aria-hidden />}
            Rapport de démarrage
          </button>
        </div>
        {datasets.length > 0 && reports !== null && reports.length > 0 && (
          <p className="mt-3 text-xs text-muted">
            Ou{" "}
            <button type="button" disabled={busy} onClick={() => void openExample()} className="text-accent-ink underline disabled:opacity-50">
              ouvrir le rapport d'exemple
            </button>{" "}
            (données du dossier samples/ du dépôt).
          </p>
        )}
        {!datasets.length && (
          <p className="mt-3 text-xs text-muted">
            Importez d'abord un fichier dans{" "}
            <button type="button" onClick={() => navigate("/donnees")} className="text-accent-ink underline">
              Données
            </button>
            .
          </p>
        )}
        {error && <p className="mt-3 text-xs text-negative">{error}</p>}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold">Mes rapports</h2>
        {reports === null ? (
          <Loader2 className="size-4 animate-spin text-muted" aria-label="Chargement" />
        ) : reports.length === 0 ? (
          <p className="text-sm text-muted">Aucun rapport pour l'instant.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {reports.map((r) => (
              <li key={r.id} className="atelier-glass group relative rounded-lg border border-border bg-surface p-4 hover:border-fg/20">
                <button type="button" onClick={() => navigate(`/rapports/${r.id}`)} className="flex w-full items-start gap-3 text-left">
                  <FileBarChart2 className="mt-0.5 size-5 shrink-0 text-accent-ink" aria-hidden />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{r.name}</span>
                    <span className="block text-xs text-muted">
                      {r.pages} page{r.pages > 1 ? "s" : ""} · {r.visuals} visuel{r.visuals > 1 ? "s" : ""}
                    </span>
                    <span className="block text-[11px] text-muted">Modifié le {dateFmt.format(new Date(r.updated_at))}</span>
                  </span>
                </button>
                {confirm === r.id ? (
                  <span className="absolute right-3 top-3 flex gap-2 text-xs">
                    <button type="button" onClick={() => void remove(r.id)} className="font-medium text-negative">
                      Supprimer
                    </button>
                    <button type="button" onClick={() => setConfirm(null)} className="text-muted">
                      Annuler
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirm(r.id)}
                    aria-label={`Supprimer ${r.name}`}
                    className="absolute right-3 top-3 rounded p-1 text-muted opacity-0 hover:text-negative focus:opacity-100 group-hover:opacity-100"
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
