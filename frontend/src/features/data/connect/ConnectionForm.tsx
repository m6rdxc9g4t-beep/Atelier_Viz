import { CheckCircle2, Loader2, Server as ServerIcon, ShieldCheck, Trash2, XCircle } from "lucide-react";
import { type ReactNode, useState } from "react";

import { api } from "../../../lib/api";
import type { Connection, ConnectionInput, ConnectorInfo, TestResult } from "../../../types/connection";
import { SERVER_KINDS } from "../../../types/connection";
import { EntraAppPanel, useEntraApp } from "./EntraAppPanel";
import { ATELIER_PROJETS_DEFAULT_URL, KIND_META, isRemoteHost, missingField, toInput } from "./meta";

const input = "w-full rounded-md border border-border bg-field px-2.5 py-1.5 text-sm text-fg placeholder:text-muted/70 focus:outline-none focus:ring-1 focus:ring-focus";

interface Props {
  info: ConnectorInfo | undefined;
  value: ConnectionInput;
  onChange: (v: ConnectionInput) => void;
  /** Connexion en cours de modification (sinon création). */
  editing: Connection | null;
  onSaved: (c: Connection) => void;
  onCancel: () => void;
  onDeleted: (id: string) => void;
  /** L'état d'un connecteur a changé (application Entra ID renseignée) : la liste des sources est à relire. */
  onConnectorsChanged?: () => void;
  /** Atelier Viz tourne sur un serveur : « cette machine » est le serveur, pas l'ordinateur devant soi. */
  remote?: boolean;
}

/** Paramètres d'une connexion : serveur et identifiants, fichier, ou application Microsoft 365. */
export function ConnectionForm({ info, value, onChange, editing, onSaved, onCancel, onDeleted, onConnectorsChanged, remote = isRemoteHost(window.location.hostname) }: Props) {
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const kind = value.kind;
  const meta = KIND_META[kind];
  const server = SERVER_KINDS.includes(kind);
  const entra = useEntraApp(kind === "sharepoint", onConnectorsChanged);
  const set = (patch: Partial<ConnectionInput>) => {
    onChange({ ...value, ...patch });
    setResult(null);
  };

  const test = async () => {
    const missing = missingField(value);
    if (missing) return setError(missing);
    setTesting(true);
    setError(null);
    try {
      // Connexion modifiée sans nouveau mot de passe : on teste la version enregistrée.
      const body = toInput(value, !!editing);
      setResult(editing && body.password === undefined ? await api.connections.test(editing.id) : await api.connections.testUnsaved(body));
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : String(e), server: null });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    const missing = missingField(value);
    if (missing) return setError(missing);
    setSaving(true);
    setError(null);
    try {
      // Application Entra ID saisie mais pas encore enregistrée : elle part avec la connexion (refusée = on s'arrête).
      if (kind === "sharepoint" && entra.dirty && !(await entra.save())) return;
      const body = toInput(value, !!editing);
      onSaved(editing ? await api.connections.update(editing.id, body) : await api.connections.create(body));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
        <div className="flex items-center gap-2">
          <meta.icon className="size-5 text-muted" aria-hidden />
          <h3 className="text-sm font-semibold">{editing ? `Modifier « ${editing.name} »` : `Nouvelle connexion ${meta.label}`}</h3>
        </div>

        <Field label="Nom de la connexion">
          <input className={input} value={value.name} onChange={(e) => set({ name: e.target.value })} maxLength={80} autoFocus />
        </Field>

        {server && (
          <>
            <div className="grid grid-cols-[1fr_7rem] gap-3">
              <Field label="Serveur" hint={kind === "sqlserver" ? "Nom ou adresse ; instance nommée : serveur\\INSTANCE" : undefined}>
                <input className={input} value={value.host ?? ""} onChange={(e) => set({ host: e.target.value })} placeholder={meta.hostPlaceholder} spellCheck={false} />
              </Field>
              <Field label="Port">
                <input
                  className={input}
                  inputMode="numeric"
                  value={value.port ?? ""}
                  onChange={(e) => set({ port: e.target.value ? Number(e.target.value.replace(/\D/g, "")) || null : null })}
                  placeholder={String(info?.default_port ?? "")}
                />
              </Field>
            </div>
            <Field label="Base de données" hint={kind === "postgres" ? "Vide : base du même nom que l'utilisateur" : "Vide : base par défaut du compte"}>
              <input className={input} value={value.database ?? ""} onChange={(e) => set({ database: e.target.value })} spellCheck={false} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Utilisateur" hint={kind === "sqlserver" ? "Compte Windows : DOMAINE\\utilisateur" : undefined}>
                <input className={input} value={value.username ?? ""} onChange={(e) => set({ username: e.target.value })} autoComplete="off" spellCheck={false} />
              </Field>
              <Field label="Mot de passe" hint={editing?.has_password ? "Laissez vide pour le garder" : undefined}>
                <input
                  className={input}
                  type="password"
                  value={value.password ?? ""}
                  onChange={(e) => set({ password: e.target.value })}
                  placeholder={editing?.has_password ? "••••••••" : ""}
                  autoComplete="new-password"
                />
              </Field>
            </div>
            {kind === "sqlserver" && (
              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={!!value.encrypt} onChange={(e) => set({ encrypt: e.target.checked })} className="accent-[var(--accent)]" />
                Exiger le chiffrement (TLS) — obligatoire pour Azure SQL
              </label>
            )}
            <p className="flex items-start gap-1.5 rounded-md bg-surface-2 px-3 py-2 text-[11px] text-muted">
              <ShieldCheck className="mt-px size-3.5 shrink-0 text-muted" aria-hidden />
              <span>
                Le mot de passe est rangé dans le trousseau de votre système, jamais dans les fichiers de l'application. Les données sont lues en lecture seule ; un compte
                limité à la lecture reste conseillé.
              </span>
            </p>
          </>
        )}

        {(kind === "sqlite" || kind === "file") && (
          <>
            {remote && <ServerNotice kind={kind} />}
            <Field
              label={remote ? "Chemin du fichier sur le serveur d'Atelier Viz" : "Chemin du fichier sur cette machine"}
              hint={
                kind === "file"
                  ? "CSV, Excel ou JSON. Un dossier OneDrive, SharePoint ou Teams synchronisé fonctionne hors ligne : l'actualisation relit la dernière version synchronisée."
                  : "Fichier .db, .sqlite ou .sqlite3, ouvert en lecture seule."
              }
            >
              <input
                className={`${input} font-mono text-xs`}
                value={value.path ?? ""}
                onChange={(e) => set({ path: e.target.value })}
                placeholder={remote ? (kind === "file" ? "/data/partage/objectifs.xlsx" : "/data/partage/boutique.db") : meta.pathPlaceholder}
                spellCheck={false}
              />
            </Field>
          </>
        )}

        {kind === "snowflake" && (
          <>
            <Field label="Compte" hint="Identifiant du compte : organisation-compte (ou localisateur.région)">
              <input className={input} value={value.host ?? ""} onChange={(e) => set({ host: e.target.value })} placeholder={meta.hostPlaceholder} spellCheck={false} />
            </Field>
            <div className="grid grid-cols-3 gap-3">
              <Field label="Base de données">
                <input className={input} value={value.database ?? ""} onChange={(e) => set({ database: e.target.value })} placeholder="ANALYTICS" spellCheck={false} />
              </Field>
              <Field label="Entrepôt">
                <input className={input} value={value.warehouse ?? ""} onChange={(e) => set({ warehouse: e.target.value })} placeholder="COMPUTE_WH" spellCheck={false} />
              </Field>
              <Field label="Rôle" hint="Un rôle en lecture seule">
                <input className={input} value={value.role ?? ""} onChange={(e) => set({ role: e.target.value })} placeholder="LECTEUR" spellCheck={false} />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Utilisateur">
                <input className={input} value={value.username ?? ""} onChange={(e) => set({ username: e.target.value })} autoComplete="off" spellCheck={false} />
              </Field>
              <Field label="Mot de passe" hint={editing?.has_password ? "Laissez vide pour le garder" : undefined}>
                <input className={input} type="password" value={value.password ?? ""} onChange={(e) => set({ password: e.target.value })} placeholder={editing?.has_password ? "••••••••" : ""} autoComplete="new-password" />
              </Field>
            </div>
            <CloudNotice />
          </>
        )}

        {kind === "bigquery" && (
          <>
            <div className="grid grid-cols-[1fr_8rem] gap-3">
              <Field label="Projet Google Cloud" hint="Projet facturé pour les requêtes">
                <input className={input} value={value.database ?? ""} onChange={(e) => set({ database: e.target.value })} placeholder="mon-projet-123" spellCheck={false} />
              </Field>
              <Field label="Go lus au plus" hint="Par requête (coût)">
                <input className={input} inputMode="numeric" value={value.max_gb ?? ""} onChange={(e) => set({ max_gb: e.target.value ? Number(e.target.value.replace(/\D/g, "")) || null : null })} placeholder="10" />
              </Field>
            </div>
            <Field label="Clé du compte de service (JSON)" hint={editing?.has_password ? "Laissez vide pour garder la clé enregistrée" : "Rôles BigQuery Data Viewer et BigQuery Job User"}>
              <textarea
                className={`${input} h-24 font-mono text-[11px]`}
                value={value.password ?? ""}
                onChange={(e) => set({ password: e.target.value })}
                placeholder={editing?.has_password ? "Clé enregistrée" : '{"type": "service_account", …}'}
                spellCheck={false}
              />
            </Field>
            <CloudNotice />
          </>
        )}

        {kind === "web" && (
          <>
            <Field
              label="Adresse du fichier"
              hint="CSV, Excel ou JSON en http(s) : données ouvertes, export publié (Google Sheets « Publier sur le Web », GitHub…), serveur interne. Hors ligne : serveurs de la machine ou du réseau de l'entreprise seulement."
            >
              <input
                className={`${input} font-mono text-xs`}
                value={value.base_url ?? ""}
                onChange={(e) => set({ base_url: e.target.value })}
                placeholder={meta.hostPlaceholder}
                spellCheck={false}
                inputMode="url"
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Utilisateur (facultatif)" hint="Avec un jeton : authentification Basic">
                <input className={input} value={value.username ?? ""} onChange={(e) => set({ username: e.target.value })} autoComplete="off" spellCheck={false} />
              </Field>
              <Field label="Jeton (facultatif)" hint={editing?.has_password ? "Laissez vide pour le garder" : "Envoyé en « Bearer » au seul serveur de l'adresse"}>
                <input
                  className={input}
                  type="password"
                  value={value.password ?? ""}
                  onChange={(e) => set({ password: e.target.value })}
                  placeholder={editing?.has_password ? "••••••••" : ""}
                  autoComplete="new-password"
                />
              </Field>
            </div>
            <p className="flex items-start gap-1.5 rounded-md bg-surface-2 px-3 py-2 text-[11px] text-muted">
              <ShieldCheck className="mt-px size-3.5 shrink-0 text-muted" aria-hidden />
              <span>Le jeton est rangé dans le trousseau du système. Une clé écrite dans l'adresse elle-même serait enregistrée en clair : préférez le champ Jeton.</span>
            </p>
          </>
        )}

        {kind === "atelier_tab" && (
          <>
            <p className="rounded-md bg-surface-2 px-3 py-2 text-xs text-muted">
              L'application de bureau Atelier Tab publie chaque table à son enregistrement (instantané DataFlow). Atelier Viz lit ce dossier : rien ne passe par le réseau,
              et « Actualiser » relit la dernière version publiée.
            </p>
            {remote && <ServerNotice kind={kind} />}
            <Field label="Dossier des tables publiées" hint={`Vide : dossier par défaut (${info?.default_location ?? meta.pathPlaceholder ?? ""}).`}>
              <input className={`${input} font-mono text-xs`} value={value.path ?? ""} onChange={(e) => set({ path: e.target.value })} placeholder={info?.default_location ?? meta.pathPlaceholder} spellCheck={false} />
            </Field>
          </>
        )}

        {kind === "atelier_projets" && (
          <>
            <p className="rounded-md bg-surface-2 px-3 py-2 text-xs text-muted">
              Éléments de travail, temps passé et jalons, lus en lecture seule sur l'API locale d'Atelier Projets (sans mot de passe). Atelier Projets doit être lancé.
            </p>
            <Field label="Adresse d'Atelier Projets" hint={`Vide : ${info?.default_location ?? ATELIER_PROJETS_DEFAULT_URL}. Adresse de cette machine uniquement (127.0.0.1, localhost ou ::1).`}>
              <input
                className={`${input} font-mono text-xs`}
                value={value.base_url ?? ""}
                onChange={(e) => set({ base_url: e.target.value })}
                placeholder={info?.default_location ?? ATELIER_PROJETS_DEFAULT_URL}
                spellCheck={false}
                inputMode="url"
              />
            </Field>
          </>
        )}

        {kind === "sharepoint" && (
          <>
            <p className="rounded-md bg-surface-2 px-3 py-2 text-xs text-muted">
              Lecture de fichiers et de listes SharePoint avec votre compte Microsoft 365 (mode « En ligne » requis). Vous vous connecterez avec un code, sans donner votre
              mot de passe à l'application.
            </p>
            <EntraAppPanel state={entra} />
            <details open={!!(value.client_id?.trim() || value.tenant?.trim())} className="text-xs">
              <summary className="cursor-pointer text-muted hover:text-fg">Autre application pour cette connexion seulement (facultatif)</summary>
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <Field label="ID d'application de cette connexion" hint="Vide : l'application ci-dessus">
                  <input className={`${input} font-mono text-xs`} value={value.client_id ?? ""} onChange={(e) => set({ client_id: e.target.value })} placeholder="00000000-0000-0000-0000-000000000000" spellCheck={false} />
                </Field>
                <Field label="Locataire de cette connexion" hint="ID de l'annuaire ou domaine (contoso.fr) ; vide : celui ci-dessus">
                  <input className={`${input} font-mono text-xs`} value={value.tenant ?? ""} onChange={(e) => set({ tenant: e.target.value })} placeholder="contoso.fr" spellCheck={false} />
                </Field>
              </div>
            </details>
          </>
        )}

        {info && !info.driver_installed && (
          <p role="alert" className="rounded-md border border-negative/40 px-3 py-2 text-xs text-negative">
            {remote ? (
              <>
                Pilote {info.label} absent sur le serveur d'Atelier Viz : il s'installe avec l'application (fichier <code>requirements-connectors.txt</code>), par la personne
                qui administre le serveur. Rien n'est à installer sur cet ordinateur.
              </>
            ) : (
              <>
                Pilote {info.label} absent. Dans le dossier <code>backend</code>, lancez <code className="rounded bg-surface-2 px-1">{info.install_hint}</code> puis redémarrez le
                serveur.
              </>
            )}
          </p>
        )}
        {error && (
          <p role="alert" className="text-xs text-negative">
            {error}
          </p>
        )}
        {result && (
          <p role="status" className={`flex items-start gap-1.5 text-xs ${result.ok ? "text-positive" : "text-negative"}`}>
            {result.ok ? <CheckCircle2 className="mt-px size-3.5 shrink-0" aria-hidden /> : <XCircle className="mt-px size-3.5 shrink-0" aria-hidden />}
            <span>
              {result.message}
              {result.server && <span className="mt-0.5 block text-[11px] text-muted">{result.server}</span>}
            </span>
          </p>
        )}
      </div>

      <footer className="flex items-center gap-2 border-t border-line px-5 py-3">
        {editing &&
          (confirmDelete ? (
            <span className="flex items-center gap-2 text-xs">
              <span className="text-muted">Supprimer la connexion ?</span>
              <button
                type="button"
                className="font-medium text-negative hover:underline"
                onClick={() => void api.connections.remove(editing.id).then(() => onDeleted(editing.id), (e: unknown) => setError(e instanceof Error ? e.message : String(e)))}
              >
                Supprimer
              </button>
              <button type="button" className="text-muted hover:underline" onClick={() => setConfirmDelete(false)}>
                Annuler
              </button>
            </span>
          ) : (
            <button type="button" onClick={() => setConfirmDelete(true)} className="flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-negative">
              <Trash2 className="size-3.5" aria-hidden /> Supprimer
            </button>
          ))}
        <span className="flex-1" />
        <button type="button" onClick={onCancel} className="rounded-md px-3 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-fg">
          Annuler
        </button>
        {kind !== "sharepoint" && (
          <button type="button" onClick={() => void test()} disabled={testing} className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-surface-2 disabled:opacity-50">
            {testing && <Loader2 className="size-3.5 animate-spin" aria-hidden />} Tester
          </button>
        )}
        <button type="submit" disabled={saving} className="atelier-btn-primary flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-50">
          {saving && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
          {editing ? "Enregistrer" : "Enregistrer et parcourir"}
        </button>
      </footer>
    </form>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      {/* Indication hors du <label> : le nom accessible du champ reste son seul libellé. */}
      <label className="block space-y-1">
        <span className="text-xs font-medium">{label}</span>
        {children}
      </label>
      {hint && <p className="text-[11px] text-muted">{hint}</p>}
    </div>
  );
}

/** Atelier Viz sur un serveur : dire quelle machine lit le fichier ou le dossier, et quoi faire d'un fichier de son poste. */
function ServerNotice({ kind }: { kind: "file" | "sqlite" | "atelier_tab" }) {
  return (
    <p role="note" className="flex items-start gap-1.5 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-muted">
      <ServerIcon className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>
        <span className="font-medium text-fg">Atelier Viz tourne ici sur un serveur.</span>{" "}
        {kind === "atelier_tab"
          ? "Ce dossier est celui du serveur : il reçoit les tables publiées par l'Atelier Tab du même serveur, pas celles de l'application de bureau de cet ordinateur."
          : "Ce chemin désigne un fichier du serveur qui fait tourner Atelier Viz (un dossier monté ou synchronisé là-bas), pas un fichier de cet ordinateur."}
        {kind === "file" && " Pour un fichier de votre poste, déposez-le dans Données ; pour un fichier OneDrive ou SharePoint, utilisez « SharePoint Online » ou « Fichier web (URL) »."}
        {kind === "sqlite" && " Une base de votre poste doit d'abord être copiée sur le serveur."}
      </span>
    </p>
  );
}

/** Rappel des entrepôts dans le nuage : en ligne seulement, secret au trousseau, lecture seule. */
function CloudNotice() {
  return (
    <p className="flex items-start gap-1.5 rounded-md bg-surface-2 px-3 py-2 text-[11px] text-muted">
      <ShieldCheck className="mt-px size-3.5 shrink-0 text-muted" aria-hidden />
      <span>Service sur Internet : utilisable en mode « En ligne » seulement. Le secret est rangé dans le trousseau du système ; seules les requêtes de lecture sont envoyées.</span>
    </p>
  );
}
