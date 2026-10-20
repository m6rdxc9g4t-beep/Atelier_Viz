import clsx from "clsx";
import { Cable, Loader2, Plus, X } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";

import { usePreferences } from "../../../hooks/usePreferences";
import { api } from "../../../lib/api";
import type { Connection, ConnectionInput, ConnectorInfo, ConnectorKind } from "../../../types/connection";
import { SUITE_KINDS } from "../../../types/connection";
import type { DatasetProfile } from "../../../types/dataset";
import { ConnectionForm } from "./ConnectionForm";
import { KIND_META, describeConnection, emptyForm, formOf } from "./meta";
import { SourceBrowser } from "./SourceBrowser";

type View = { kind: "pick" } | { kind: "form"; form: ConnectionInput; editing: Connection | null } | { kind: "browse"; id: string };

/**
 * « Obtenir des données » : bases SQL (SQL Server, PostgreSQL, MySQL, SQLite), fichiers synchronisés
 * (OneDrive, SharePoint, partage réseau), SharePoint Online et applications de la Suite Atelier
 * (Atelier Tab, Atelier Projets). Les connexions sont enregistrées ; un import copie les données dans
 * la base locale, actualisable ensuite.
 */
export function ConnectDialog({ onClose, onImported, initialKind }: { onClose: () => void; onImported: (p: DatasetProfile) => void; initialKind?: ConnectorKind }) {
  const titleId = useId();
  const { prefs } = usePreferences();
  const online = prefs?.online_mode ?? false;
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [view, setView] = useState<View>(initialKind ? { kind: "form", form: emptyForm(initialKind), editing: null } : { kind: "pick" });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.connections.connectors(), api.connections.list()])
      .then(([infos, list]) => {
        setConnectors(infos);
        setConnections(list);
        if (!initialKind && list[0]) setView({ kind: "browse", id: list[0].id });
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [initialKind]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const upsert = useCallback((c: Connection) => {
    setConnections((list) => (list?.some((x) => x.id === c.id) ? list.map((x) => (x.id === c.id ? c : x)) : [...(list ?? []), c]));
  }, []);

  const current = view.kind === "browse" ? connections?.find((c) => c.id === view.id) : undefined;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="atelier-pop flex h-[min(46rem,92vh)] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-border bg-surface text-fg shadow-2xl">
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Cable className="size-4 text-accent-ink" aria-hidden />
          <h2 id={titleId} className="flex-1 text-sm font-semibold">
            Se connecter à une source
          </h2>
          <span className={clsx("rounded-full px-2 py-0.5 text-[11px]", online ? "bg-accent-soft text-accent-ink" : "bg-surface-2 text-muted")}>
            {online ? "En ligne" : "Hors ligne : réseau local et VPN uniquement"}
          </span>
          <button type="button" onClick={onClose} aria-label="Fermer" className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg">
            <X className="size-4" aria-hidden />
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          <nav aria-label="Connexions enregistrées" className="flex w-60 shrink-0 flex-col border-r border-border bg-bg/40">
            <p className="px-3 pt-3 pb-1 text-[10px] font-medium tracking-wide text-muted uppercase">Connexions</p>
            <div className="min-h-0 flex-1 overflow-y-auto px-2">
              {connections === null && !error && <Loader2 className="mx-auto mt-4 size-4 animate-spin text-muted" aria-label="Chargement" />}
              {connections?.length === 0 && <p className="px-1 py-2 text-xs text-muted">Aucune connexion enregistrée.</p>}
              {connections?.map((c) => {
                const Icon = KIND_META[c.kind].icon;
                const active = view.kind === "browse" && view.id === c.id;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setView({ kind: "browse", id: c.id })}
                    aria-current={active}
                    className={clsx("mb-0.5 flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left", active ? "bg-surface-2" : "hover:bg-surface-2/60")}
                  >
                    <Icon className={clsx("mt-0.5 size-4 shrink-0", active ? "text-accent-ink" : "text-muted")} aria-hidden />
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium">{c.name}</span>
                      <span className="block truncate text-[11px] text-muted">{describeConnection(c) || KIND_META[c.kind].label}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="border-t border-border p-2">
              <button
                type="button"
                onClick={() => setView({ kind: "pick" })}
                aria-pressed={view.kind === "pick"}
                className={clsx("flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium", view.kind === "pick" ? "bg-accent text-accent-fg" : "text-accent-ink hover:bg-accent-soft")}
              >
                <Plus className="size-3.5" aria-hidden /> Nouvelle connexion
              </button>
            </div>
          </nav>

          <main className="flex min-h-0 min-w-0 flex-1 flex-col">
            {error && (
              <p role="alert" className="m-4 rounded-md border border-negative/40 px-3 py-2 text-xs text-negative">
                {error}
              </p>
            )}
            {view.kind === "pick" && <ConnectorPicker connectors={connectors} online={online} onPick={(k) => setView({ kind: "form", form: emptyForm(k), editing: null })} />}
            {view.kind === "form" && (
              <ConnectionForm
                key={view.editing?.id ?? `new-${view.form.kind}`}
                info={connectors.find((i) => i.kind === view.form.kind)}
                value={view.form}
                onChange={(form) => setView({ ...view, form })}
                editing={view.editing}
                onSaved={(c) => {
                  upsert(c);
                  setView({ kind: "browse", id: c.id });
                }}
                onCancel={() => setView(view.editing ? { kind: "browse", id: view.editing.id } : { kind: "pick" })}
                onDeleted={(id) => {
                  const rest = (connections ?? []).filter((c) => c.id !== id);
                  setConnections(rest);
                  setView(rest[0] ? { kind: "browse", id: rest[0].id } : { kind: "pick" });
                }}
              />
            )}
            {view.kind === "browse" && current && (
              <SourceBrowser
                key={current.id}
                connection={current}
                online={online}
                sharepointConfigured={connectors.find((i) => i.kind === "sharepoint")?.configured ?? true}
                onEdit={() => setView({ kind: "form", form: formOf(current), editing: current })}
                onChanged={upsert}
                onImported={(p) => {
                  onImported(p);
                  onClose();
                }}
              />
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

/** Choix du type de source (« Obtenir des données » de Power BI) : Suite Atelier d'abord, puis bases et fichiers. */
function ConnectorPicker({ connectors, online, onPick }: { connectors: ConnectorInfo[]; online: boolean; onPick: (k: ConnectorKind) => void }) {
  const suite = connectors.filter((c) => SUITE_KINDS.includes(c.kind));
  const others = connectors.filter((c) => !SUITE_KINDS.includes(c.kind));
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      <h3 className="text-sm font-semibold">Nouvelle connexion</h3>
      <p className="mt-1 text-xs text-muted">Applications de la Suite Atelier, bases de l'entreprise, fichiers synchronisés depuis OneDrive ou SharePoint, ou SharePoint Online directement.</p>
      {suite.length > 0 && (
        <>
          <p className="mt-4 text-[10px] font-medium tracking-wide text-muted uppercase">Suite Atelier</p>
          <ConnectorGrid connectors={suite} online={online} onPick={onPick} />
          <p className="mt-4 text-[10px] font-medium tracking-wide text-muted uppercase">Bases et fichiers</p>
        </>
      )}
      <ConnectorGrid connectors={others} online={online} onPick={onPick} />
    </div>
  );
}

function ConnectorGrid({ connectors, online, onPick }: { connectors: ConnectorInfo[]; online: boolean; onPick: (k: ConnectorKind) => void }) {
  return (
    <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {connectors.map((info) => {
          const Icon = KIND_META[info.kind].icon;
          const note = !info.driver_installed
            ? `Pilote à installer : ${info.install_hint ?? ""}`
            : info.needs_online && !online
              ? "Mode « En ligne » requis"
              : !info.configured
                ? "Application Entra ID à renseigner"
                : null;
          return (
            <button
              key={info.kind}
              type="button"
              onClick={() => onPick(info.kind)}
              className="flex items-start gap-3 rounded-lg border border-border p-3 text-left transition-colors hover:border-accent-ink/60 hover:bg-accent/5"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-2">
                <Icon className="size-4.5 text-accent-ink" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">{info.label}</span>
                <span className="block text-xs text-muted">{info.description}</span>
                {note && <span className={clsx("mt-1 block text-[11px]", info.driver_installed ? "text-muted" : "font-mono text-negative")}>{note}</span>}
              </span>
            </button>
          );
        })}
    </div>
  );
}
