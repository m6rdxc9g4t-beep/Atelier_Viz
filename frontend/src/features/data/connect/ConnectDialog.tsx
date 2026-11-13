import clsx from "clsx";
import { Cable, Loader2, Plus, X } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";

import { usePreferences } from "../../../hooks/usePreferences";
import { api } from "../../../lib/api";
import type { Connection, ConnectionInput, ConnectorInfo, ConnectorKind } from "../../../types/connection";
import { SUITE_KINDS } from "../../../types/connection";
import type { DatasetProfile } from "../../../types/dataset";
import { ConnectionForm } from "./ConnectionForm";
import { KIND_META, describeConnection, driverNote, emptyForm, formOf, isRemoteHost } from "./meta";
import { SourceBrowser } from "./SourceBrowser";
import { useModalFocus } from "../../../hooks/useModalFocus";

type View = { kind: "pick" } | { kind: "form"; form: ConnectionInput; editing: Connection | null } | { kind: "browse"; id: string };

/**
 * « Obtenir des données » : bases SQL (SQL Server, PostgreSQL, MySQL, SQLite), fichiers synchronisés
 * (OneDrive, SharePoint, partage réseau), SharePoint Online et applications de la Suite Atelier
 * (Atelier Tab, Atelier Projets). Les connexions sont enregistrées ; un import copie les données dans
 * la base locale, actualisable ensuite.
 */
export function ConnectDialog({ onClose, onImported, initialKind }: { onClose: () => void; onImported: (p: DatasetProfile) => void; initialKind?: ConnectorKind }) {
  const titleId = useId();
  const dialogRef = useModalFocus<HTMLDivElement>();
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

  // Application Entra ID renseignée depuis le formulaire : « à renseigner » disparaît de la liste des sources.
  const reloadConnectors = useCallback(() => {
    api.connections.connectors().then(setConnectors, () => undefined);
  }, []);
  const remote = isRemoteHost(window.location.hostname);

  const upsert = useCallback((c: Connection) => {
    setConnections((list) => (list?.some((x) => x.id === c.id) ? list.map((x) => (x.id === c.id ? c : x)) : [...(list ?? []), c]));
  }, []);

  const current = view.kind === "browse" ? connections?.find((c) => c.id === view.id) : undefined;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="atelier-pop flex h-[min(46rem,92vh)] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-border bg-surface text-fg shadow-2xl">
        <header className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-line px-4 py-3">
          <Cable className="size-4 text-muted" aria-hidden />
          <h2 id={titleId} className="flex-1 text-sm font-semibold">
            Se connecter à une source
          </h2>
          <span className={clsx("rounded-full px-2 py-0.5 text-[11px] max-sm:order-last", online ? "bg-accent-soft text-accent-ink" : "bg-surface-2 text-muted")}>
            {online ? "En ligne" : "Hors ligne : réseau local et VPN uniquement"}
          </span>
          <button type="button" onClick={onClose} aria-label="Fermer" className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg">
            <X className="size-4" aria-hidden />
          </button>
        </header>

        {/* Écran étroit : les connexions passent au-dessus (bandeau de hauteur bornée) au lieu d'écraser le formulaire. */}
        <div className="flex min-h-0 flex-1 max-md:flex-col">
          <nav aria-label="Connexions enregistrées" className="flex w-60 shrink-0 flex-col border-r border-line bg-bg/40 max-md:max-h-40 max-md:w-full max-md:border-r-0 max-md:border-b">
            <p className="px-3 pt-3 pb-1 text-2xs font-medium text-faint">Connexions</p>
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
            <div className="border-t border-line p-2">
              <button
                type="button"
                onClick={() => setView({ kind: "pick" })}
                aria-pressed={view.kind === "pick"}
                className={clsx("flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium", view.kind === "pick" ? "bg-accent-soft text-accent-ink" : "text-accent-ink hover:bg-accent-soft")}
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
            {view.kind === "pick" && <ConnectorPicker connectors={connectors} online={online} remote={remote} onPick={(k) => setView({ kind: "form", form: emptyForm(k), editing: null })} />}
            {view.kind === "form" && (
              <ConnectionForm
                key={view.editing?.id ?? `new-${view.form.kind}`}
                info={connectors.find((i) => i.kind === view.form.kind)}
                value={view.form}
                onChange={(form) => setView({ ...view, form })}
                editing={view.editing}
                onConnectorsChanged={reloadConnectors}
                remote={remote}
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
                onImportedMany={(profiles, complete) => {
                  // Du dernier au premier : chaque jeu se place en tête, le premier finit affiché, l'ordre est gardé.
                  for (const p of [...profiles].reverse()) onImported(p);
                  if (complete) onClose();
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
function ConnectorPicker({ connectors, online, remote, onPick }: { connectors: ConnectorInfo[]; online: boolean; remote: boolean; onPick: (k: ConnectorKind) => void }) {
  const suite = connectors.filter((c) => SUITE_KINDS.includes(c.kind));
  const others = connectors.filter((c) => !SUITE_KINDS.includes(c.kind));
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      <h3 className="text-sm font-semibold">Nouvelle connexion</h3>
      <p className="mt-1 text-xs text-muted">Applications de la Suite Atelier, bases de l'entreprise, fichiers synchronisés depuis OneDrive ou SharePoint, ou SharePoint Online directement.</p>
      {suite.length > 0 && (
        <>
          <p className="mt-4 text-2xs font-medium text-faint">Suite Atelier</p>
          <ConnectorGrid connectors={suite} online={online} remote={remote} onPick={onPick} />
          <p className="mt-4 text-2xs font-medium text-faint">Bases et fichiers</p>
        </>
      )}
      <ConnectorGrid connectors={others} online={online} remote={remote} onPick={onPick} />
    </div>
  );
}

function ConnectorGrid({ connectors, online, remote, onPick }: { connectors: ConnectorInfo[]; online: boolean; remote: boolean; onPick: (k: ConnectorKind) => void }) {
  return (
    <div className="mt-2 grid gap-2 sm:grid-cols-2">
        {connectors.map((info) => {
          const Icon = KIND_META[info.kind].icon;
          // SharePoint : les deux manques se disent ensemble (application à renseigner, mode « En ligne »).
          const needs = [!info.configured ? "Application Entra ID à renseigner à l'étape suivante" : null, info.needs_online && !online ? "Mode « En ligne » requis" : null].filter(Boolean);
          const note = !info.driver_installed ? driverNote(info.install_hint, remote) : needs.length ? needs.join(" · ") : null;
          // Sur un serveur, « un dossier de la machine » est un dossier du serveur : le dire dès le choix de la source.
          const where = remote && (info.kind === "file" || info.kind === "sqlite") ? "Lit un fichier du serveur qui fait tourner Atelier Viz, pas de cet ordinateur." : null;
          return (
            <button
              key={info.kind}
              type="button"
              onClick={() => onPick(info.kind)}
              className="flex items-start gap-3 rounded-lg border border-border p-3 text-left transition-colors hover:bg-surface-2"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-2">
                <Icon className="size-4.5 text-muted" aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">{info.label}</span>
                <span className="block text-xs text-muted">{info.description}</span>
                {where && <span className="mt-1 block text-[11px] text-muted">{where}</span>}
                {note && <span className={clsx("mt-1 block text-[11px]", info.driver_installed ? "text-muted" : remote ? "text-negative" : "font-mono text-negative")}>{note}</span>}
              </span>
            </button>
          );
        })}
    </div>
  );
}
