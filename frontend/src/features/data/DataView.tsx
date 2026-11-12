import clsx from "clsx";
import { Cable, CalendarClock, Cloud, Database, FileSpreadsheet, Link2, Loader2, RefreshCw, Replace, Trash2, TriangleAlert, Wand2, Workflow, X } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import type { DatasetsState, PendingReplace } from "../../hooks/useDatasets";
import { formatCount } from "../../lib/format";
import { sheetChoices } from "../../lib/workbook";
import { isConnectionOrigin } from "../../types/connection";
import type { DatasetSummary } from "../../types/dataset";
import { RelationsDialog } from "../../studio/RelationsDialog";
import { DatasetSchedulePanel } from "../automation/DatasetSchedulePanel";
import { ConnectDialog } from "./connect/ConnectDialog";
import { KIND_META, sinceLabel } from "./connect/meta";
import { DataPreview } from "./DataPreview";
import { PrepEditor } from "./prep/PrepEditor";
import { SheetsDialog } from "./SheetsDialog";
import { FieldsPanel, TYPE_META } from "./FieldsPanel";
import { ACCEPT, UploadDropzone } from "./UploadDropzone";

/** Page « Données » : import, liste des jeux, panneau Champs et aperçu. */
export function DataView({ state }: { state: DatasetsState }) {
  const { datasets, selected, uploading, error } = state;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [relating, setRelating] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const replaceInput = useRef<HTMLInputElement>(null);
  const connectButton = (
    <button
      type="button"
      onClick={() => setConnecting(true)}
      className="flex shrink-0 items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-2"
    >
      <Cable className="size-3.5 text-muted" aria-hidden /> Se connecter à une source
    </button>
  );

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

      {state.notice && (
        <div role="status" className="flex items-start gap-3 rounded-lg border border-border bg-surface px-4 py-3 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
          <span className="flex-1">{state.notice}</span>
          <button type="button" onClick={state.clearNotice} aria-label="Fermer le message" className="text-muted hover:text-fg">
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
              <button type="button" disabled={uploading} onClick={() => void state.loadSamples()} className="font-medium text-accent-ink hover:underline disabled:opacity-50">
                Charger les données d'exemple
              </button>{" "}
              (ventes 2026 et magasins).
            </p>
            <div className="atelier-card flex flex-col items-center gap-2 rounded-lg border border-border bg-surface px-4 py-4 text-center">
              <p className="text-sm font-medium">Ou connectez-vous à vos données</p>
              <p className="text-xs text-muted">SQL Server, PostgreSQL, MySQL, SQLite, fichiers OneDrive / SharePoint synchronisés, SharePoint Online.</p>
              {connectButton}
            </div>
          </div>
        )
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto max-sm:basis-full" role="tablist" aria-label="Jeux de données">
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
                  <SourceIcon dataset={d} />
                  {d.name}
                </button>
              ))}
            </div>
            {connectButton}
            <UploadDropzone variant="compact" onFile={state.upload} uploading={uploading} />
          </div>

          {selected && (
            <>
              <div className="atelier-card flex flex-wrap items-center gap-x-6 gap-y-2 rounded-lg border border-border bg-surface px-4 py-3">
                <div className="mr-auto min-w-0">
                  <h2 className="truncate text-sm font-semibold">{selected.name}</h2>
                  {selected.origin?.kind === "atelier-table" && (
                    <p className="flex items-center gap-1 truncate text-[11px] text-muted">
                      Alimenté par un workflow (Atelier Nexus) · clé « {selected.origin.key} » · mis à jour {sinceLabel(selected.origin.refreshed_at)}
                    </p>
                  )}
                  {isConnectionOrigin(selected.origin) && (
                    <p className="flex items-center gap-1 truncate text-[11px] text-muted">
                      {KIND_META[selected.origin.kind].label} · {selected.origin.connection_name} · actualisé {sinceLabel(selected.origin.refreshed_at)}
                      {selected.origin.truncated && (
                        <span className="ml-1 flex items-center gap-0.5 text-negative" title="La limite de lignes choisie à l'import a été atteinte">
                          <TriangleAlert className="size-3" aria-hidden /> limite de lignes atteinte
                        </span>
                      )}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setPreparing(true)}
                  title="Renommer, changer les types, filtrer, nettoyer… (étapes rejouées à chaque actualisation)"
                  className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-surface-2"
                >
                  <Wand2 className="size-3.5 text-muted" aria-hidden />
                  Préparer{selected.steps?.length ? ` (${selected.steps.length})` : ""}
                </button>
                {datasets.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setRelating(true)}
                    title="Relier ce jeu à un autre (ex. ventes → régions)"
                    className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-surface-2"
                  >
                    <Link2 className="size-3.5 text-muted" aria-hidden />
                    Relations{selected.model?.relations?.length ? ` (${selected.model.relations.length})` : ""}
                  </button>
                )}
                {!selected.origin && (
                  <>
                    <input
                      ref={replaceInput}
                      type="file"
                      accept={ACCEPT}
                      className="sr-only"
                      tabIndex={-1}
                      aria-label={`Choisir le fichier qui remplace les données de ${selected.name}`}
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void state.replaceData(selected.id, file);
                        e.target.value = "";
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => replaceInput.current?.click()}
                      disabled={state.replacing === selected.id}
                      title="Charger le nouvel export de ce fichier : même jeu, les rapports, le modèle et les alertes suivent"
                      className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-surface-2 disabled:opacity-60"
                    >
                      {state.replacing === selected.id ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Replace className="size-3.5 text-muted" aria-hidden />}
                      {state.replacing === selected.id ? "Remplacement…" : "Remplacer les données…"}
                    </button>
                  </>
                )}
                {isConnectionOrigin(selected.origin) && (
                  <button
                    type="button"
                    onClick={() => void state.refresh(selected.id)}
                    disabled={state.refreshing === selected.id}
                    title="Relire la source et mettre à jour les rapports"
                    className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-surface-2 disabled:opacity-60"
                  >
                    <RefreshCw className={clsx("size-3.5", state.refreshing === selected.id && "animate-spin")} aria-hidden />
                    {state.refreshing === selected.id ? "Actualisation…" : "Actualiser"}
                  </button>
                )}
                {isConnectionOrigin(selected.origin) && (
                  <button
                    type="button"
                    onClick={() => setPlanning((p) => !p)}
                    aria-expanded={planning}
                    title="Actualiser automatiquement (toutes les N minutes / heures, ou chaque jour)"
                    className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium hover:bg-surface-2 aria-expanded:bg-surface-3"
                  >
                    <CalendarClock className="size-3.5" aria-hidden /> Planifier
                  </button>
                )}
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

              {state.pendingReplace?.id === selected.id && <ReplaceConfirm pending={state.pendingReplace} onConfirm={(p) => void state.replaceData(p.id, p.file, true)} onCancel={state.cancelReplace} />}

              <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3 sm:gap-3 lg:grid-cols-6" aria-label="Profil du jeu de données">
                <Kpi label="Lignes" value={formatCount(selected.rows)} />
                <Kpi label="Colonnes" value={formatCount(selected.columns_count)} />
                {(["number", "date", "string", "boolean"] as const).map((t) => {
                  const n = selected.columns.filter((c) => c.type === t).length;
                  if (!n) return null;
                  const { icon: Icon, label } = TYPE_META[t];
                  return <Kpi key={t} label={`${label}${n > 1 ? "s" : ""}`} value={formatCount(n)} icon={<Icon className="size-3.5 shrink-0 text-faint" aria-hidden />} />;
                })}
              </dl>

              {planning && isConnectionOrigin(selected.origin) && <DatasetSchedulePanel datasetId={selected.id} refreshedAt={selected.origin.refreshed_at} />}

              <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:min-h-[24rem] lg:grid-cols-[18rem_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)]">
                <div className="flex max-h-[28rem] min-w-0 flex-col lg:max-h-none lg:min-h-0">
                  <FieldsPanel columns={selected.columns} />
                </div>
                <div className="flex h-[32rem] min-w-0 flex-col lg:h-auto lg:min-h-0">
                  <DataPreview key={`${selected.id}:${selected.rows}:${JSON.stringify(selected.steps ?? [])}:${selected.origin?.refreshed_at ?? ""}:${state.revision}`} datasetId={selected.id} columns={selected.columns} total={selected.rows} />
                </div>
              </div>
            </>
          )}
        </>
      )}
      {preparing && selected && <PrepEditor profile={selected} onClose={() => setPreparing(false)} onSaved={(p) => state.select(p.id)} />}
      {relating && selected && <RelationsDialog profile={selected} datasets={datasets} onClose={() => setRelating(false)} onSaved={(p) => state.select(p.id)} />}
      {connecting && <ConnectDialog onClose={() => setConnecting(false)} onImported={state.added} />}
      {state.pendingWorkbook && (
        <SheetsDialog
          filename={state.pendingWorkbook.file.name}
          sheets={sheetChoices(state.pendingWorkbook.sheets)}
          importing={uploading}
          error={state.pendingWorkbook.error}
          onImport={(sheets) => void state.importSheets(sheets)}
          onClose={state.cancelWorkbook}
        />
      )}
    </div>
  );
}

const quoted = (columns: string[]) => columns.map((c) => `« ${c} »`).join(", ");

/**
 * Confirmation avant de remplacer les données par un fichier auquel il manque des colonnes du jeu (mauvais fichier
 * choisi ?) : rien n'a encore changé ; les colonnes perdues sont nommées, « Annuler » a le focus.
 */
function ReplaceConfirm({ pending, onConfirm, onCancel }: { pending: PendingReplace; onConfirm: (pending: PendingReplace) => void; onCancel: () => void }) {
  const many = pending.missing.length > 1;
  return (
    <div role="alertdialog" aria-label="Confirmer le remplacement des données" aria-describedby="replace-confirm-text" className="atelier-card flex flex-wrap items-start gap-x-4 gap-y-2 rounded-lg border border-border bg-surface px-4 py-3 text-xs">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
      <div id="replace-confirm-text" className="min-w-0 flex-1 space-y-0.5">
        <p className="font-medium">
          « {pending.file.name} » n'a plus {many ? "les colonnes" : "la colonne"} {quoted(pending.missing)}.
        </p>
        <p className="text-muted">
          Rien n'a changé pour l'instant. Si vous remplacez, les visuels, filtres et alertes qui {many ? "les" : "l'"}utilisent ne fonctionneront plus.
          {pending.added.length > 0 && ` ${pending.added.length > 1 ? "Nouvelles colonnes" : "Nouvelle colonne"} du fichier : ${quoted(pending.added)}.`}
        </p>
      </div>
      <span className="flex shrink-0 items-center gap-3">
        <button type="button" onClick={() => onConfirm(pending)} className="font-medium text-negative hover:underline">
          Remplacer quand même
        </button>
        <button type="button" autoFocus onClick={onCancel} className="text-muted hover:underline">
          Annuler
        </button>
      </span>
    </div>
  );
}

function SourceIcon({ dataset }: { dataset: DatasetSummary }) {
  if (dataset.origin?.kind === "atelier-table") return <Workflow className="size-3.5" aria-label="Workflow" />;
  const kind = isConnectionOrigin(dataset.origin) ? dataset.origin.kind : undefined;
  const Icon = kind === "sharepoint" ? Cloud : kind === "atelier_tab" || kind === "atelier_projets" ? KIND_META[kind].icon : kind && kind !== "file" ? Database : FileSpreadsheet;
  return <Icon className="size-3.5" aria-label={kind ? KIND_META[kind].label : undefined} aria-hidden={!kind} />;
}

/** Carte de chiffre (`atelier-kpi`, coins de 12 px) du profil du jeu : lignes, colonnes, colonnes par type. */
function Kpi({ label, value, icon }: { label: string; value: string; icon?: ReactNode }) {
  return (
    <div className="atelier-kpi">
      <dt className="atelier-kpi__label flex min-w-0 items-center gap-1.5 truncate">
        {icon}
        {label}
      </dt>
      <dd className="atelier-kpi__value">{value}</dd>
    </div>
  );
}
