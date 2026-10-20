import clsx from "clsx";
import { Copy, ExternalLink, Eye, Loader2, LogOut, Pencil, PlugZap, Search, Table2, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../../../lib/api";
import type { Connection, DeviceCodeStart, PreviewResult, ProjectRef, SourceSpec, TableRef, TestResult } from "../../../types/connection";
import { SQL_KINDS } from "../../../types/connection";
import type { DatasetProfile } from "../../../types/dataset";
import { KIND_META, describeConnection, groupSnapshots, groupTables, sourceDetails, suggestedName } from "./meta";

const PREVIEW_ROWS = 50;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

interface Props {
  connection: Connection;
  online: boolean;
  /** SharePoint : application Entra ID renseignée côté serveur (SHAREPOINT_CLIENT_ID). */
  sharepointConfigured?: boolean;
  onEdit: () => void;
  onChanged: (c: Connection) => void;
  onImported: (profile: DatasetProfile) => void;
}

/** Parcours d'une source enregistrée : tables, requête, feuilles ou lien SharePoint → aperçu → import. */
export function SourceBrowser({ connection: c, online, sharepointConfigured = true, onEdit, onChanged, onImported }: Props) {
  const meta = KIND_META[c.kind];
  const sql = SQL_KINDS.includes(c.kind);
  const [mode, setMode] = useState<"tables" | "query">("tables");
  const [tables, setTables] = useState<TableRef[] | null>(null);
  const [tablesTruncated, setTablesTruncated] = useState(false);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("SELECT *\nFROM ");
  const [url, setUrl] = useState("");
  const [source, setSource] = useState<SourceSpec | null>(null);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [loading, setLoading] = useState<"tables" | "preview" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [maxRows, setMaxRows] = useState("");
  const [test, setTest] = useState<TestResult | null>(null);
  const [projects, setProjects] = useState<ProjectRef[]>([]);
  const [projectId, setProjectId] = useState("");
  const [location, setLocation] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const needsLogin = c.kind === "sharepoint" && !c.signed_in;

  const loadTables = useCallback(
    async (forUrl?: string) => {
      setLoading("tables");
      setError(null);
      try {
        const res = await api.connections.tables(c.id, forUrl);
        setTables(res.tables);
        setTablesTruncated(res.truncated);
        setProjects(res.projects);
        setLocation(res.location);
        return res.tables;
      } catch (e) {
        setError(errorText(e));
        setTables([]);
        return [];
      } finally {
        setLoading(null);
      }
    },
    [c.id],
  );

  const show = useCallback(
    async (spec: SourceSpec) => {
      abort.current?.abort();
      const ctrl = new AbortController();
      abort.current = ctrl;
      setSource(spec);
      setName(suggestedName(c, spec));
      setLoading("preview");
      setError(null);
      try {
        setPreview(await api.connections.preview(c.id, { ...spec, limit: PREVIEW_ROWS }, ctrl.signal));
      } catch (e) {
        if (ctrl.signal.aborted) return;
        setPreview(null);
        setError(errorText(e));
      } finally {
        if (!ctrl.signal.aborted) setLoading(null);
      }
    },
    [c],
  );

  // À l'ouverture : tables d'une base, feuilles d'un classeur (ou aperçu direct d'un CSV).
  useEffect(() => {
    setTables(null);
    setPreview(null);
    setSource(null);
    setError(null);
    setTest(null);
    if (c.kind === "sharepoint") return;
    void loadTables().then((list) => {
      if (c.kind === "file" && list.length === 0) void show({});
      else if (c.kind === "file" && list[0]) void show({ table: list[0] });
    });
    return () => abort.current?.abort();
  }, [c.id, c.kind, loadTables, show]);

  const runImport = async () => {
    if (!source) return;
    setLoading("import");
    setError(null);
    try {
      const limit = Number(maxRows.replace(/\s/g, ""));
      onImported(await api.connections.import(c.id, { ...source, name: name.trim() || null, max_rows: limit > 0 ? limit : null }));
    } catch (e) {
      setError(errorText(e));
      setLoading(null);
    }
  };

  const openSharePoint = async () => {
    if (!url.trim()) return;
    const sheets = await loadTables(url.trim());
    void show({ url: url.trim(), table: sheets[0] ?? null });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-border px-5 py-3">
        <meta.icon className="size-5 shrink-0 text-accent-ink" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">{c.name}</h3>
          <p className="truncate text-xs text-muted">
            {meta.label}
            {describeConnection(c) && ` · ${describeConnection(c)}`}
          </p>
        </div>
        {test && <span className={clsx("max-w-64 truncate text-xs", test.ok ? "text-positive" : "text-negative")} title={test.server ?? test.message}>{test.message}</span>}
        <button
          type="button"
          onClick={() => void api.connections.test(c.id).then(setTest, (e: unknown) => setTest({ ok: false, message: errorText(e), server: null }))}
          className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-fg"
        >
          <PlugZap className="size-3.5" aria-hidden /> Tester
        </button>
        <button type="button" onClick={onEdit} className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-fg">
          <Pencil className="size-3.5" aria-hidden /> Modifier
        </button>
      </header>

      {c.kind === "sharepoint" && !c.client_id && !sharepointConfigured && (
        <p role="alert" className="mx-5 mt-3 flex items-start gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 text-xs">
          <TriangleAlert className="mt-px size-3.5 shrink-0 text-negative" aria-hidden />
          <span>
            Il manque l'application Entra ID de votre entreprise : renseignez son identifiant via « Modifier », ou SHAREPOINT_CLIENT_ID dans backend/.env (voir README,
            « Connecteurs »). En attendant, un fichier SharePoint synchronisé par OneDrive s'ouvre avec « Fichier synchronisé ».
          </span>
        </p>
      )}
      {c.kind === "sharepoint" && !online && (
        <p role="alert" className="mx-5 mt-3 flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2 text-xs">
          <TriangleAlert className="size-3.5 text-negative" aria-hidden /> SharePoint Online est sur Internet : passez en mode « En ligne » (en haut à droite) pour l'utiliser.
        </p>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[16rem_minmax(0,1fr)]">
        {/* Colonne de gauche : ce qu'on lit */}
        <div className="flex min-h-0 flex-col border-r border-border">
          {sql && (
            <div className="flex border-b border-border text-xs" role="tablist">
              {(["tables", "query"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="tab"
                  aria-selected={mode === m}
                  onClick={() => setMode(m)}
                  className={clsx("flex-1 py-2 font-medium", mode === m ? "border-b-2 border-accent text-fg" : "text-muted hover:text-fg")}
                >
                  {m === "tables" ? "Tables" : "Requête SQL"}
                </button>
              ))}
            </div>
          )}

          {sql && mode === "tables" && (
            <>
              <label className="m-2 flex items-center gap-1.5 rounded-md border border-border bg-field px-2 py-1 text-xs focus-within:ring-1 focus-within:ring-focus">
                <Search className="size-3.5 text-muted" aria-hidden />
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Rechercher une table" aria-label="Rechercher une table" className="min-w-0 flex-1 bg-transparent outline-none" />
              </label>
              <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
                {loading === "tables" && <Loader2 className="mx-auto mt-6 size-4 animate-spin text-muted" aria-label="Chargement des tables" />}
                {tables && tables.length === 0 && loading !== "tables" && <p className="p-3 text-xs text-muted">Aucune table visible avec ce compte.</p>}
                {tables &&
                  groupTables(tables, search).map(([schema, list]) => (
                    <div key={schema} className="mb-1">
                      {schema && <p className="px-2 pt-2 pb-0.5 text-[10px] font-medium tracking-wide text-muted uppercase">{schema}</p>}
                      {list.map((t) => {
                        const active = source?.table?.name === t.name && source.table.schema === t.schema;
                        return (
                          <button
                            key={`${t.schema}.${t.name}`}
                            type="button"
                            onClick={() => void show({ table: t })}
                            aria-pressed={active}
                            className={clsx(
                              "flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs",
                              active ? "bg-accent-soft font-medium text-accent-ink" : "hover:bg-surface-2",
                            )}
                          >
                            {t.kind === "view" ? <Eye className="size-3.5 shrink-0 opacity-60" aria-label="Vue" /> : <Table2 className="size-3.5 shrink-0 opacity-60" aria-hidden />}
                            <span className="truncate">{t.name}</span>
                          </button>
                        );
                      })}
                    </div>
                  ))}
                {tablesTruncated && <p className="px-2 text-[11px] text-muted">Liste limitée : utilisez la recherche ou une requête.</p>}
              </div>
            </>
          )}

          {sql && mode === "query" && (
            <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
              <textarea
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") void show({ query });
                }}
                spellCheck={false}
                aria-label="Requête SQL"
                className="min-h-0 flex-1 resize-none rounded-md border border-border bg-field p-2 font-mono text-xs leading-relaxed outline-none focus:ring-1 focus:ring-focus"
              />
              <p className="text-[11px] text-muted">Une seule requête SELECT ou WITH, en lecture seule. Ctrl + Entrée : aperçu.</p>
              <button type="button" onClick={() => void show({ query })} className="rounded-md border border-border py-1.5 text-xs font-medium hover:bg-surface-2">
                Aperçu
              </button>
            </div>
          )}

          {c.kind === "file" && (
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              <p className="px-1 pb-1 text-[11px] text-muted">{c.path}</p>
              {tables?.map((t) => (
                <button
                  key={t.name}
                  type="button"
                  onClick={() => void show({ table: t })}
                  aria-pressed={source?.table?.name === t.name}
                  className={clsx("flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs", source?.table?.name === t.name ? "bg-accent-soft font-medium text-accent-ink" : "hover:bg-surface-2")}
                >
                  <Table2 className="size-3.5 opacity-60" aria-hidden /> {t.name}
                </button>
              ))}
            </div>
          )}

          {c.kind === "atelier_tab" && (
            <>
              <label className="m-2 flex items-center gap-1.5 rounded-md border border-border bg-field px-2 py-1 text-xs focus-within:ring-1 focus-within:ring-focus">
                <Search className="size-3.5 text-muted" aria-hidden />
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Rechercher une table" aria-label="Rechercher une table" className="min-w-0 flex-1 bg-transparent outline-none" />
              </label>
              <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
                {loading === "tables" && <Loader2 className="mx-auto mt-6 size-4 animate-spin text-muted" aria-label="Chargement des tables" />}
                {tables && tables.length === 0 && loading !== "tables" && !error && (
                  <p className="p-3 text-xs text-muted">Aucune table publiée pour l'instant : enregistrez une table dans l'application de bureau Atelier Tab.</p>
                )}
                {tables &&
                  groupSnapshots(tables, search).map(([project, list]) => (
                    <div key={project} className="mb-1">
                      <p className="truncate px-2 pt-2 pb-0.5 text-[10px] font-medium tracking-wide text-muted uppercase" title={project}>
                        {project}
                      </p>
                      {list.map((t) => (
                        <SourceItem key={t.id ?? t.name} table={t} active={source?.table?.id === t.id} onPick={() => void show({ table: t })} />
                      ))}
                    </div>
                  ))}
              </div>
              {location && (
                <p className="truncate border-t border-border px-3 py-1.5 font-mono text-[10px] text-muted" title={location}>
                  {location}
                </p>
              )}
            </>
          )}

          {c.kind === "atelier_projets" && (
            <div className="flex min-h-0 flex-1 flex-col">
              <label className="m-2 block space-y-1">
                <span className="text-[11px] font-medium">Projet</span>
                <select
                  value={projectId}
                  onChange={(e) => {
                    setProjectId(e.target.value);
                    if (source?.table) void show({ table: source.table, project_id: e.target.value || null });
                  }}
                  className="w-full rounded-md border border-border bg-field px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-focus"
                >
                  <option value="">Tous les projets</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
              <p className="px-3 pt-1 pb-0.5 text-[10px] font-medium tracking-wide text-muted uppercase">Jeux de données</p>
              <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
                {loading === "tables" && <Loader2 className="mx-auto mt-6 size-4 animate-spin text-muted" aria-label="Chargement des jeux de données" />}
                {tables?.map((t) => (
                  <SourceItem key={t.id ?? t.name} table={t} active={source?.table?.id === t.id} onPick={() => void show({ table: t, project_id: projectId || null })} />
                ))}
                {tables && (
                  <button type="button" onClick={() => void loadTables()} className="mx-2 mt-2 text-[11px] text-muted hover:text-fg hover:underline">
                    Recharger la liste
                  </button>
                )}
              </div>
            </div>
          )}

          {c.kind === "sharepoint" && (
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
              <MicrosoftLogin connection={c} online={online} onChanged={onChanged} />
              {!needsLogin && (
                <>
                  <label className="block space-y-1">
                    <span className="text-xs font-medium">Lien du fichier ou de la liste</span>
                    <textarea
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      rows={4}
                      placeholder="https://entreprise.sharepoint.com/sites/Ventes/Documents/objectifs.xlsx"
                      className="w-full resize-none rounded-md border border-border bg-field p-2 font-mono text-[11px] outline-none focus:ring-1 focus:ring-focus"
                      spellCheck={false}
                    />
                    <span className="block text-[11px] text-muted">Dans SharePoint : « Copier le lien » d'un fichier (CSV, Excel, JSON), ou l'adresse d'une liste.</span>
                  </label>
                  <button type="button" disabled={!url.trim() || !online} onClick={() => void openSharePoint()} className="w-full rounded-md border border-border py-1.5 text-xs font-medium hover:bg-surface-2 disabled:opacity-50">
                    Ouvrir
                  </button>
                  {tables && tables.length > 0 && (
                    <div>
                      <p className="pb-1 text-[11px] text-muted">Feuilles</p>
                      {tables.map((t) => (
                        <button
                          key={t.name}
                          type="button"
                          onClick={() => void show({ url: url.trim(), table: t })}
                          aria-pressed={source?.table?.name === t.name}
                          className={clsx("flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-xs", source?.table?.name === t.name ? "bg-accent-soft font-medium text-accent-ink" : "hover:bg-surface-2")}
                        >
                          <Table2 className="size-3.5 opacity-60" aria-hidden /> {t.name}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          )}
        </div>

        {/* Colonne de droite : aperçu et import */}
        <div className="flex min-h-0 min-w-0 flex-col">
          <div className="min-h-0 flex-1 overflow-auto">
            {error && (
              <p role="alert" className="m-4 rounded-md border border-negative/40 px-3 py-2 text-xs text-negative">
                {error}
              </p>
            )}
            {loading === "preview" && <Loader2 className="mx-auto mt-16 size-5 animate-spin text-muted" aria-label="Chargement de l'aperçu" />}
            {!preview && !error && loading !== "preview" && (
              <p className="mt-16 px-6 text-center text-xs text-muted">
                {sql
                  ? "Choisissez une table ou écrivez une requête pour voir un aperçu."
                  : c.kind === "atelier_tab"
                    ? "Choisissez une table publiée par Atelier Tab pour voir un aperçu."
                    : c.kind === "atelier_projets"
                      ? "Choisissez un jeu de données (et, si besoin, un projet) pour voir un aperçu."
                  : c.kind === "sharepoint"
                    ? needsLogin
                      ? "Connectez-vous à Microsoft 365, puis collez le lien d'un fichier ou d'une liste."
                      : "Collez un lien puis « Ouvrir »."
                    : "Aperçu du fichier…"}
              </p>
            )}
            {preview && loading !== "preview" && <PreviewTable preview={preview} />}
          </div>
          {preview && (
            <footer className="flex flex-wrap items-end gap-3 border-t border-border px-4 py-3">
              <label className="min-w-48 flex-1 space-y-1">
                <span className="text-[11px] text-muted">Nom du jeu de données</span>
                <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-md border border-border bg-field px-2.5 py-1.5 text-sm outline-none focus:ring-1 focus:ring-focus" />
              </label>
              <label className="w-36 space-y-1">
                <span className="text-[11px] text-muted">Lignes max. (facultatif)</span>
                <input
                  value={maxRows}
                  onChange={(e) => setMaxRows(e.target.value.replace(/[^\d\s]/g, ""))}
                  inputMode="numeric"
                  placeholder="toutes"
                  className="w-full rounded-md border border-border bg-field px-2.5 py-1.5 text-sm tabular-nums outline-none focus:ring-1 focus:ring-focus"
                />
              </label>
              <button
                type="button"
                onClick={() => void runImport()}
                disabled={loading === "import"}
                className="atelier-btn-primary flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-50"
              >
                {loading === "import" && <Loader2 className="size-4 animate-spin" aria-hidden />}
                Importer
              </button>
              <p className="basis-full text-[11px] text-muted">
                Les données sont copiées dans la base locale : les rapports restent rapides et fonctionnent hors ligne. Le bouton « Actualiser » du jeu relit la source.
              </p>
            </footer>
          )}
        </div>
      </div>
    </div>
  );
}

/** Table publiée (Atelier Tab) ou jeu de données (Atelier Projets) : nom, détails, description. */
function SourceItem({ table: t, active, onPick }: { table: TableRef; active: boolean; onPick: () => void }) {
  const details = sourceDetails(t);
  return (
    <button
      type="button"
      onClick={onPick}
      aria-pressed={active}
      title={t.description ?? undefined}
      className={clsx("flex w-full items-start gap-1.5 rounded px-2 py-1.5 text-left text-xs", active ? "bg-accent-soft text-accent-ink" : "hover:bg-surface-2")}
    >
      <Table2 className="mt-px size-3.5 shrink-0 opacity-60" aria-hidden />
      <span className="min-w-0">
        <span className={clsx("block truncate", active && "font-medium")}>{t.name}</span>
        {details && <span className="block truncate text-[11px] text-muted">{details}</span>}
      </span>
    </button>
  );
}

/** Valeur d'aperçu à la française : nombres « 1 234,5 », booléens Oui / Non, dates ISO raccourcies. */
function cell(v: string | number | boolean): string {
  if (typeof v === "boolean") return v ? "Oui" : "Non";
  if (typeof v === "number") return v.toLocaleString("fr-FR", { maximumFractionDigits: 6, useGrouping: Math.abs(v) >= 10000 });
  return /^\d{4}-\d{2}-\d{2}T00:00:00$/.test(v) ? v.slice(0, 10) : v;
}

function PreviewTable({ preview }: { preview: PreviewResult }) {
  return (
    <div>
      <p className="sticky top-0 left-0 z-10 border-b border-border bg-surface px-4 py-1.5 text-[11px] text-muted">
        {preview.rows.length} ligne{preview.rows.length > 1 ? "s" : ""}
        {preview.truncated ? ` affichée${preview.rows.length > 1 ? "s" : ""} (aperçu) — la source en contient davantage` : ""} · {preview.columns.length} colonnes
      </p>
      <table className="w-max min-w-full border-collapse text-xs">
        <thead>
          <tr>
            {preview.columns.map((col) => (
              <th key={col} className="sticky top-[29px] border-b border-border bg-surface-2 px-3 py-1.5 text-left font-medium whitespace-nowrap">
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {preview.rows.map((row, i) => (
            <tr key={i} className="odd:bg-surface-2/40">
              {preview.columns.map((col) => {
                const v = row[col];
                return (
                  <td key={col} className={clsx("max-w-64 truncate border-b border-border/60 px-3 py-1 whitespace-nowrap", typeof v === "number" && "text-right tabular-nums")}>
                    {v === null || v === undefined ? <span className="text-muted/60">—</span> : cell(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Connexion Microsoft 365 par code d'appareil, avec suivi automatique. */
function MicrosoftLogin({ connection: c, online, onChanged }: { connection: Connection; online: boolean; onChanged: (c: Connection) => void }) {
  const [start, setStart] = useState<DeviceCodeStart | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!start) return;
    let alive = true;
    const timer = setInterval(() => {
      void api.connections.poll(c.id).then(
        async (s) => {
          if (!alive || s.status === "pending") return;
          clearInterval(timer);
          setStart(null);
          if (s.status === "signed_in") {
            setStatus(null);
            const fresh = (await api.connections.list()).find((x) => x.id === c.id);
            if (fresh) onChanged(fresh);
          } else setStatus(s.message ?? "Connexion interrompue.");
        },
        (e: unknown) => {
          clearInterval(timer);
          if (alive) {
            setStart(null);
            setStatus(errorText(e));
          }
        },
      );
    }, Math.max(2, start.interval) * 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [start, c.id, onChanged]);

  if (c.signed_in) {
    return (
      <div className="flex items-center gap-2 rounded-md bg-surface-2 px-3 py-2 text-xs">
        <span className="size-2 shrink-0 rounded-full bg-positive" aria-hidden />
        <span className="min-w-0 flex-1 truncate" title={c.account ?? ""}>
          {c.account ?? "Connecté"}
        </span>
        <button type="button" title="Se déconnecter" aria-label="Se déconnecter de Microsoft 365" onClick={() => void api.connections.logout(c.id).then(onChanged)} className="rounded p-1 text-muted hover:text-fg">
          <LogOut className="size-3.5" aria-hidden />
        </button>
      </div>
    );
  }

  if (start) {
    return (
      <div className="space-y-2 rounded-md border border-accent-ink/40 bg-accent/5 p-3 text-xs">
        <p>1. Ouvrez la page de connexion Microsoft :</p>
        <a href={start.verification_uri} target="_blank" rel="noreferrer" className="flex items-center gap-1 font-medium text-accent-ink hover:underline">
          {start.verification_uri.replace(/^https:\/\//, "")} <ExternalLink className="size-3" aria-hidden />
        </a>
        <p>2. Saisissez ce code :</p>
        <div className="flex items-center gap-2">
          <code className="rounded bg-surface px-2 py-1 font-mono text-base font-semibold tracking-widest">{start.user_code}</code>
          <button
            type="button"
            aria-label="Copier le code"
            onClick={() => void navigator.clipboard.writeText(start.user_code).then(() => setCopied(true), () => undefined)}
            className="rounded p-1 text-muted hover:text-fg"
          >
            <Copy className="size-3.5" aria-hidden />
          </button>
          {copied && <span className="text-[11px] text-muted">copié</span>}
        </div>
        <p className="flex items-center gap-1.5 text-muted">
          <Loader2 className="size-3 animate-spin" aria-hidden /> En attente de la connexion…
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        disabled={busy || !online}
        onClick={() => {
          setBusy(true);
          setStatus(null);
          api.connections
            .login(c.id)
            .then(setStart, (e: unknown) => setStatus(errorText(e)))
            .finally(() => setBusy(false));
        }}
        className="atelier-btn-primary flex w-full items-center justify-center gap-1.5 rounded-md bg-accent py-2 text-xs font-medium text-accent-fg disabled:opacity-50"
      >
        {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />} Se connecter à Microsoft 365
      </button>
      {status && (
        <p role="alert" className="text-[11px] text-negative">
          {status}
        </p>
      )}
    </div>
  );
}

