import { CheckCircle2, Loader2, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";

import { api } from "../../../lib/api";
import type { SharePointApp } from "../../../types/connection";
import { ENTRA_STEPS, entraAppError } from "./meta";

const input = "w-full rounded-md border border-border bg-field px-2.5 py-1.5 font-mono text-xs text-fg placeholder:text-muted/70 focus:outline-none focus:ring-1 focus:ring-focus";

export interface EntraAppState {
  /** Application enregistrée (null pendant le chargement). */
  app: SharePointApp | null;
  clientId: string;
  tenant: string;
  setClientId: (v: string) => void;
  setTenant: (v: string) => void;
  /** La saisie diffère de ce qui est enregistré. */
  dirty: boolean;
  saving: boolean;
  error: string | null;
  /** Dit après un enregistrement réussi, jusqu'à la saisie suivante. */
  notice: string | null;
  /** Enregistre la saisie ; faux si elle est refusée (le message est dans `error`). */
  save: () => Promise<boolean>;
  clear: () => Promise<void>;
}

/**
 * Application Entra ID de SharePoint : lecture, saisie et enregistrement (`PUT /api/connections/sharepoint-app`).
 * `onChanged` : l'état « à renseigner » de la liste des sources est à relire.
 */
export function useEntraApp(enabled: boolean, onChanged?: () => void): EntraAppState {
  const [app, setApp] = useState<SharePointApp | null>(null);
  const [clientId, setClientIdRaw] = useState("");
  const [tenant, setTenantRaw] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const adopt = useCallback((next: SharePointApp) => {
    setApp(next);
    setClientIdRaw(next.client_id ?? "");
    setTenantRaw(next.tenant ?? "");
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    api.connections.sharepointApp().then(
      (a) => alive && adopt(a),
      (e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)),
    );
    return () => {
      alive = false;
    };
  }, [enabled, adopt]);

  const edit = (set: (v: string) => void) => (v: string) => {
    set(v);
    setError(null);
    setNotice(null);
  };

  const put = async (id: string, dir: string, done: string): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      adopt(await api.connections.setSharepointApp({ client_id: id || null, tenant: dir || null }));
      setNotice(done);
      onChanged?.();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const save = async (): Promise<boolean> => {
    const id = clientId.trim();
    const dir = tenant.trim();
    const problem =
      entraAppError(id, dir) ??
      (!id ? "Collez l'« ID d'application (client) » de la page Vue d'ensemble de l'application." : null) ??
      // Les étapes créent une application à locataire unique : elle ne se connecte que sur son annuaire.
      (!dir ? "Collez aussi l'« ID de l'annuaire (locataire) » : l'application ne se connecte que sur son annuaire." : null);
    if (problem) {
      setError(problem);
      return false;
    }
    return put(id, dir, "Application enregistrée : elle sert à toutes les connexions SharePoint.");
  };

  const clear = async () => {
    await put("", "", "Réglage effacé.");
  };

  // Un GUID s'écrit en majuscules ou en minuscules (l'environnement du serveur le donne tel quel) : même identifiant.
  const dirty = !!app && (clientId.trim().toLowerCase() !== (app.client_id ?? "").toLowerCase() || tenant.trim() !== (app.tenant ?? ""));
  return { app, clientId, tenant, setClientId: edit(setClientIdRaw), setTenant: edit(setTenantRaw), dirty, saving, error, notice, save, clear };
}

/**
 * Bloc « Application Entra ID » du formulaire SharePoint : les étapes exactes à suivre dans Entra, puis les
 * deux identifiants à recopier. Une application « client public » n'a pas de secret : rien de confidentiel ici.
 */
export function EntraAppPanel({ state }: { state: EntraAppState }) {
  const titleId = useId();
  const { app } = state;
  const source = app?.source ?? "none";
  // Entrée dans un champ : enregistre l'application, pas la connexion du formulaire qui entoure ce bloc.
  const onEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    void state.save();
  };
  return (
    <section aria-labelledby={titleId} className="space-y-3 rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h4 id={titleId} className="text-xs font-semibold">
          Application Entra ID
        </h4>
        <span className={`text-[11px] ${app && source === "none" ? "text-warn" : "text-muted"}`}>
          {!app ? "Lecture…" : source === "none" ? "À renseigner" : source === "interface" ? "Renseignée ici" : "Fournie par le serveur (SHAREPOINT_CLIENT_ID)"}
        </span>
      </div>
      <p className="text-xs text-muted">
        SharePoint Online ne se lit qu'à travers une application inscrite dans l'annuaire Microsoft 365 de votre entreprise (Entra ID). Elle se crée une fois, par un
        administrateur ou avec son accord, et sert à toutes vos connexions SharePoint.
      </p>
      <details open={source === "none"} className="text-xs">
        <summary className="cursor-pointer font-medium hover:text-accent-ink">Créer l'application dans Entra : les étapes</summary>
        <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-muted marker:text-faint">
          {ENTRA_STEPS.map((s) => (
            <li key={s.title}>
              <span className="font-medium text-fg">{s.title}.</span> {s.detail}
            </li>
          ))}
        </ol>
      </details>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-xs font-medium">ID d'application (client)</span>
          <input className={input} value={state.clientId} onChange={(e) => state.setClientId(e.target.value)} onKeyDown={onEnter} placeholder="00000000-0000-0000-0000-000000000000" spellCheck={false} autoComplete="off" />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium">ID de l'annuaire (locataire)</span>
          <input className={input} value={state.tenant} onChange={(e) => state.setTenant(e.target.value)} onKeyDown={onEnter} placeholder="00000000-0000-0000-0000-000000000000" spellCheck={false} autoComplete="off" />
        </label>
      </div>
      <p className="flex items-start gap-1.5 text-[11px] text-muted">
        <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden />
        <span>
          Ces deux identifiants ne sont pas des secrets : une application « client public » n'en a pas, et Atelier Viz n'en demande aucun. Le domaine de l'entreprise
          (contoso.fr) est accepté à la place de l'ID de l'annuaire.
        </span>
      </p>
      {state.error && (
        <p role="alert" className="text-xs text-negative">
          {state.error}
        </p>
      )}
      {state.notice && (
        <p role="status" className="flex items-start gap-1.5 text-xs text-positive">
          <CheckCircle2 className="mt-px size-3.5 shrink-0" aria-hidden /> {state.notice}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void state.save()}
          disabled={state.saving || !app || !state.dirty}
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-surface-2 disabled:opacity-50"
        >
          {state.saving && <Loader2 className="size-3.5 animate-spin" aria-hidden />} Enregistrer l'application
        </button>
        {source === "interface" && (
          <button type="button" onClick={() => void state.clear()} disabled={state.saving} className="rounded-md px-2 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-negative disabled:opacity-50">
            Effacer
          </button>
        )}
        {source === "environment" && <span className="text-[11px] text-muted">Une application saisie ici remplace celle du serveur.</span>}
      </div>
    </section>
  );
}
