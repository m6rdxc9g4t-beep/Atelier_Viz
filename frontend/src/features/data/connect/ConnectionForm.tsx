import { CheckCircle2, Loader2, ShieldCheck, Trash2, XCircle } from "lucide-react";
import { type ReactNode, useState } from "react";

import { api } from "../../../lib/api";
import type { Connection, ConnectionInput, ConnectorInfo, TestResult } from "../../../types/connection";
import { SERVER_KINDS } from "../../../types/connection";
import { KIND_META, missingField, toInput } from "./meta";

const input = "w-full rounded-md border border-border bg-bg px-2.5 py-1.5 text-sm text-fg placeholder:text-muted/70 focus:outline-none focus:ring-1 focus:ring-accent";

interface Props {
  info: ConnectorInfo | undefined;
  value: ConnectionInput;
  onChange: (v: ConnectionInput) => void;
  /** Connexion en cours de modification (sinon création). */
  editing: Connection | null;
  onSaved: (c: Connection) => void;
  onCancel: () => void;
  onDeleted: (id: string) => void;
}

/** Paramètres d'une connexion : serveur et identifiants, fichier, ou application Microsoft 365. */
export function ConnectionForm({ info, value, onChange, editing, onSaved, onCancel, onDeleted }: Props) {
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const kind = value.kind;
  const meta = KIND_META[kind];
  const server = SERVER_KINDS.includes(kind);
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
          <meta.icon className="size-5 text-accent" aria-hidden />
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
              <ShieldCheck className="mt-px size-3.5 shrink-0 text-accent" aria-hidden />
              <span>
                Le mot de passe est rangé dans le trousseau de votre système, jamais dans les fichiers de l'application. Les données sont lues en lecture seule ; un compte
                limité à la lecture reste conseillé.
              </span>
            </p>
          </>
        )}

        {(kind === "sqlite" || kind === "file") && (
          <Field
            label="Chemin du fichier sur cette machine"
            hint={
              kind === "file"
                ? "CSV, Excel ou JSON. Un dossier OneDrive, SharePoint ou Teams synchronisé fonctionne hors ligne : l'actualisation relit la dernière version synchronisée."
                : "Fichier .db, .sqlite ou .sqlite3, ouvert en lecture seule."
            }
          >
            <input className={`${input} font-mono text-xs`} value={value.path ?? ""} onChange={(e) => set({ path: e.target.value })} placeholder={meta.pathPlaceholder} spellCheck={false} />
          </Field>
        )}

        {kind === "sharepoint" && (
          <>
            <p className="rounded-md bg-surface-2 px-3 py-2 text-xs text-muted">
              Lecture de fichiers et de listes SharePoint avec votre compte Microsoft 365 (mode « En ligne » requis). Vous vous connecterez avec un code, sans donner votre
              mot de passe à l'application.
            </p>
            <Field label="Locataire Microsoft 365" hint="Domaine de l'entreprise (contoso.fr) ; vide = tout compte professionnel">
              <input className={input} value={value.tenant ?? ""} onChange={(e) => set({ tenant: e.target.value })} placeholder="contoso.fr" spellCheck={false} />
            </Field>
            <Field
              label="Identifiant d'application (Entra ID)"
              hint={
                info?.configured
                  ? "Facultatif : l'application configurée dans backend/.env (SHAREPOINT_CLIENT_ID) est utilisée par défaut."
                  : "Requis : application Entra ID de votre entreprise (voir README, « Connecteurs »), ou SHAREPOINT_CLIENT_ID dans backend/.env."
              }
            >
              <input className={`${input} font-mono text-xs`} value={value.client_id ?? ""} onChange={(e) => set({ client_id: e.target.value })} placeholder="00000000-0000-0000-0000-000000000000" spellCheck={false} />
            </Field>
          </>
        )}

        {info && !info.driver_installed && (
          <p role="alert" className="rounded-md border border-negative/40 px-3 py-2 text-xs text-negative">
            Pilote {info.label} absent. Dans le dossier <code>backend</code>, lancez <code className="rounded bg-surface-2 px-1">{info.install_hint}</code> puis redémarrez le serveur.
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

      <footer className="flex items-center gap-2 border-t border-border px-5 py-3">
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
        <button type="submit" disabled={saving} className="flex items-center gap-1.5 rounded-md bg-fg px-3 py-1.5 text-xs font-medium text-bg disabled:opacity-50">
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
