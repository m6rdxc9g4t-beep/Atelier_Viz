import clsx from "clsx";
import { FileSpreadsheet, Trash2, X } from "lucide-react";
import { useState } from "react";

import type { DatasetsState } from "../../hooks/useDatasets";
import { formatCount } from "../../lib/format";
import { DataPreview } from "./DataPreview";
import { FieldsPanel, TYPE_META } from "./FieldsPanel";
import { UploadDropzone } from "./UploadDropzone";

/** Page « Données » : import, liste des jeux, panneau Champs et aperçu. */
export function DataView({ state }: { state: DatasetsState }) {
  const { datasets, selected, uploading, error } = state;
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="mx-auto flex h-full max-w-7xl flex-col gap-4">
      {error && (
        <div role="alert" className="flex items-start gap-3 rounded-lg border border-negative/40 px-4 py-3 text-sm text-negative">
          <span className="flex-1">{error}</span>
          <button type="button" onClick={state.clearError} aria-label="Fermer le message">
            <X className="size-4" aria-hidden />
          </button>
        </div>
      )}

      {datasets.length === 0 ? (
        !state.loading && (
          <div className="space-y-3">
            <UploadDropzone onFile={state.upload} uploading={uploading} />
            <p className="text-center text-xs text-muted">
              Pas de fichier sous la main ?{" "}
              <button type="button" disabled={uploading} onClick={() => void state.loadSamples()} className="font-medium text-accent hover:underline disabled:opacity-50">
                Charger les données d'exemple
              </button>{" "}
              (ventes 2026 et magasins).
            </p>
          </div>
        )
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto" role="tablist" aria-label="Jeux de données">
              {datasets.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  role="tab"
                  aria-selected={selected?.id === d.id}
                  onClick={() => state.select(d.id)}
                  className={clsx(
                    "flex shrink-0 items-center gap-2 rounded-md border px-3 py-1.5 text-xs",
                    selected?.id === d.id
                      ? "border-fg/20 bg-surface font-medium text-fg"
                      : "border-transparent text-muted hover:bg-surface-2 hover:text-fg",
                  )}
                >
                  <FileSpreadsheet className="size-3.5" aria-hidden />
                  {d.name}
                </button>
              ))}
            </div>
            <UploadDropzone variant="compact" onFile={state.upload} uploading={uploading} />
          </div>

          {selected && (
            <>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-border bg-surface px-4 py-3">
                <h2 className="mr-auto truncate text-sm font-semibold">{selected.name}</h2>
                <Stat label="Lignes" value={formatCount(selected.rows)} />
                <Stat label="Colonnes" value={formatCount(selected.columns_count)} />
                {(["number", "date", "string", "boolean"] as const).map((t) => {
                  const n = selected.columns.filter((c) => c.type === t).length;
                  if (!n) return null;
                  const { icon: Icon, label } = TYPE_META[t];
                  return (
                    <span key={t} className="flex items-center gap-1.5 text-xs text-muted" title={label}>
                      <Icon className="size-3.5 text-accent" aria-hidden />
                      {n} <span className="sr-only">{label}</span>
                    </span>
                  );
                })}
                {confirmDelete ? (
                  <span className="flex items-center gap-2 text-xs">
                    <span className="text-muted">Supprimer définitivement ?</span>
                    <button
                      type="button"
                      onClick={() => {
                        void state.remove(selected.id);
                        setConfirmDelete(false);
                      }}
                      className="font-medium text-negative hover:underline"
                    >
                      Supprimer
                    </button>
                    <button type="button" onClick={() => setConfirmDelete(false)} className="text-muted hover:underline">
                      Annuler
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    aria-label={`Supprimer ${selected.name}`}
                    className="rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-negative"
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </button>
                )}
              </div>

              <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:min-h-[24rem] lg:grid-cols-[18rem_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]">
                <div className="flex max-h-[28rem] min-w-0 flex-col lg:max-h-none lg:min-h-0">
                  <FieldsPanel columns={selected.columns} />
                </div>
                <div className="flex h-[32rem] min-w-0 flex-col lg:h-auto lg:min-h-0">
                  <DataPreview datasetId={selected.id} columns={selected.columns} total={selected.rows} />
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="text-xs text-muted">
      {label} <span className="font-medium tabular-nums text-fg">{value}</span>
    </span>
  );
}
