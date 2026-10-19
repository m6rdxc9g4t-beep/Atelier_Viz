import clsx from "clsx";
import { CloudDownload, CloudUpload, ExternalLink, GitBranch, KeyRound, Loader2, ShieldCheck, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";

import { usePreferences } from "../../hooks/usePreferences";
import { api } from "../../lib/api";
import { openExternal } from "../../lib/desktop";
import type { Conflict, GitHubConfig, GitHubState, GitHubTest, PullResult, PushResult, Resolution } from "../../types/github";
import { whenLabel } from "../automation/schedule";
import { STATE_LABEL, configError, pendingCount, resultLines, sharedContent, visibilityWarning } from "./github";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const input = "rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-fg";
const EMPTY: GitHubConfig = { repo: "", branch: "main", folder: "atelier-viz/rapports", strip_private: true };

/**
 * Réglages GitHub : dépôt, branche, dossier, jeton (trousseau) ; « Envoyer » (un commit) et
 * « Récupérer » avec résolution explicite des conflits. Rapports uniquement (jamais les tables des jeux) ;
 * filtres, sélections et adresses de webhook retirés avant l'envoi sauf si l'utilisateur décoche l'option.
 */
export function GitHubSection() {
  const id = useId();
  const { prefs } = usePreferences();
  const online = prefs?.online_mode ?? false;
  const [state, setState] = useState<GitHubState | null>(null);
  const [form, setForm] = useState<GitHubConfig>(EMPTY);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<"save" | "test" | "push" | "pull" | null>(null);
  const [test, setTest] = useState<GitHubTest | null>(null);
  const [result, setResult] = useState<{ kind: "push" | "pull"; res: PushResult | PullResult } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("");

  const load = useCallback(() => {
    api.github
      .state()
      .then((s) => {
        setState(s);
        if (s.config) setForm({ ...EMPTY, ...s.config });
      })
      .catch((e: unknown) => setError(message(e)));
  }, []);
  useEffect(load, [load, online]);

  const run = async <T,>(what: "save" | "test" | "push" | "pull", fn: () => Promise<T>): Promise<T | null> => {
    setBusy(what);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(message(e));
      return null;
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    const s = await run("save", () => api.github.configure({ ...form, token: token ? token : undefined }));
    if (s) {
      setState(s);
      setToken("");
      setTest(null);
    }
  };

  const push = async (resolutions: Record<string, "local"> = {}) => {
    const res = await run("push", () => api.github.push({ message: commitMessage.trim() || null, resolutions }));
    if (res) {
      setResult({ kind: "push", res });
      setCommitMessage("");
      load();
    }
  };

  const pull = async (resolutions: Record<string, Resolution> = {}) => {
    const res = await run("pull", () => api.github.pull({ resolutions }));
    if (res) {
      setResult({ kind: "pull", res });
      load();
    }
  };

  const invalid = configError(form);
  const dirty = !state?.config || JSON.stringify(form) !== JSON.stringify(state.config) || token !== "";
  const ready = !!state?.config && state.has_token;
  const pending = state ? pendingCount(state.reports) : 0;
  const shared = sharedContent(form.strip_private);
  const repoPrivate = test?.private ?? state?.repo_private ?? null;
  const publicWarning = visibilityWarning(repoPrivate, state?.config?.strip_private ?? form.strip_private);

  return (
    <section className="rounded-xl border border-border bg-surface p-5" aria-labelledby={`${id}-title`}>
      <div className="flex items-center gap-2">
        <GitBranch className="size-4 text-accent" aria-hidden />
        <h2 id={`${id}-title`} className="flex-1 text-base font-semibold">
          Synchronisation GitHub
        </h2>
        {state?.account && <span className="text-[11px] text-muted">Connecté : {state.account}</span>}
      </div>
      <p className="mt-1 text-xs text-muted">Versionnez vos rapports dans un dépôt GitHub et partagez-les avec votre équipe.</p>
      <p className="mt-2 flex items-start gap-1.5 rounded-md border border-border bg-bg px-3 py-2 text-[11px] text-muted">
        <ShieldCheck className="mt-px size-3.5 shrink-0 text-positive" aria-hidden />
        <span>
          <strong className="font-medium text-fg">Ce qui part :</strong> {shared.sent}.{" "}
          {shared.removed ? (
            <>
              <strong className="font-medium text-fg">Retirés avant l'envoi :</strong> {shared.removed} (ils restent sur ce poste et ne sont pas écrasés à la récupération).{" "}
            </>
          ) : (
            <strong className="font-medium text-negative">Nettoyage désactivé : les valeurs des filtres et des sélections (données réelles) et les adresses de webhook (souvent secrètes) partent aussi. </strong>
          )}
          <strong className="font-medium text-fg">Jamais :</strong> {shared.never}. Le jeton est rangé dans le trousseau du système.
        </span>
      </p>
      {!online && (
        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-negative">
          <TriangleAlert className="size-3.5" aria-hidden /> Mode hors ligne : la configuration s'enregistre, mais envoyer et récupérer exigent le mode « En ligne ».
        </p>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-[11px] text-muted">
          Dépôt (propriétaire/dépôt)
          <input value={form.repo} onChange={(e) => setForm({ ...form, repo: e.target.value.trim() })} placeholder="mon-equipe/rapports-bi" className={input} spellCheck={false} />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-muted">
          Branche
          <input value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value.trim() })} className={input} spellCheck={false} />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-muted">
          Dossier du dépôt
          <input value={form.folder} onChange={(e) => setForm({ ...form, folder: e.target.value })} placeholder="atelier-viz/rapports" className={input} spellCheck={false} />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-muted">
          <span className="flex items-center gap-1">
            <KeyRound className="size-3" aria-hidden /> Jeton d'accès{" "}
            {state?.has_token && <span className="text-positive">— enregistré{state.token_from_env ? " (GITHUB_TOKEN)" : " dans le trousseau"}</span>}
          </span>
          <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={state?.has_token ? "•••••••• (inchangé)" : "github_pat_…"} autoComplete="off" className={input} />
        </label>
      </div>
      <label className="mt-3 flex items-start gap-2 text-[11px] text-fg">
        <input type="checkbox" checked={form.strip_private} onChange={(e) => setForm({ ...form, strip_private: e.target.checked })} className="mt-0.5" />
        <span>
          Retirer les sélections, filtres et adresses de webhook avant l'envoi <span className="text-muted">(recommandé)</span>
        </span>
      </label>
      <p className="mt-1.5 text-[11px] text-muted">
        Jeton « fine-grained » limité à ce dépôt, permission <em>Contents : Read and write</em>.{" "}
        <button type="button" onClick={() => openExternal("https://github.com/settings/personal-access-tokens/new")} className="inline-flex items-center gap-0.5 text-accent hover:underline">
          Créer un jeton <ExternalLink className="size-3" aria-hidden />
        </button>
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" disabled={!!invalid || !dirty || busy !== null} onClick={() => void save()} className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg hover:brightness-110 disabled:opacity-40">
          {busy === "save" ? "Enregistrement…" : "Enregistrer"}
        </button>
        <button
          type="button"
          disabled={!ready || !online || busy !== null || dirty}
          onClick={() => void run("test", api.github.test).then((t) => t && (setTest(t), load()))}
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-2 disabled:opacity-40"
        >
          {busy === "test" && <Loader2 className="size-3.5 animate-spin" aria-hidden />} Tester la connexion
        </button>
        {state?.config && (
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void run("save", api.github.disconnect).then((s) => s && (setState(s), setForm(EMPTY), setTest(null), setResult(null)))}
            className="ml-auto text-xs text-muted hover:text-negative hover:underline"
          >
            Oublier ce dépôt et le jeton
          </button>
        )}
      </div>
      {form.repo && invalid && <p className="mt-2 text-[11px] text-negative">{invalid}</p>}
      {test && <p className={clsx("mt-2 text-[11px]", test.ok ? "text-positive" : "text-negative")}>{test.message}</p>}
      {publicWarning && (
        <p role="alert" className="mt-2 flex items-start gap-1.5 rounded-md border border-negative/50 px-3 py-2 text-[11px] font-medium text-negative">
          <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden /> {publicWarning}
        </p>
      )}

      {ready && state && (
        <div className="mt-5 border-t border-border pt-4">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-48 flex-1 flex-col gap-1 text-[11px] text-muted">
              Message du commit (facultatif)
              <input value={commitMessage} onChange={(e) => setCommitMessage(e.target.value)} maxLength={500} placeholder="Atelier Viz : N rapport(s) mis à jour" className={input} />
            </label>
            <button type="button" disabled={!online || busy !== null} onClick={() => void push()} className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg hover:brightness-110 disabled:opacity-40">
              {busy === "push" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <CloudUpload className="size-3.5" aria-hidden />} Envoyer{pending ? ` (${pending})` : ""}
            </button>
            <button type="button" disabled={!online || busy !== null} onClick={() => void pull()} className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-2 disabled:opacity-40">
              {busy === "pull" ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <CloudDownload className="size-3.5" aria-hidden />} Récupérer
            </button>
          </div>
          <p className="mt-2 text-[11px] text-muted">
            {state.last_push ? (
              <>
                Dernier envoi {whenLabel(state.last_push.at)} — {state.last_push.summary}
                {state.last_push.commit_url && (
                  <>
                    {" "}
                    <button type="button" onClick={() => state.last_push?.commit_url && openExternal(state.last_push.commit_url)} className="text-accent hover:underline">
                      voir le commit
                    </button>
                  </>
                )}
                {". "}
              </>
            ) : (
              "Jamais envoyé. "
            )}
            {state.last_pull ? `Dernière récupération ${whenLabel(state.last_pull.at)}.` : ""}
          </p>

          {result && <ResultBox kind={result.kind} res={result.res} busy={busy !== null} onPull={(r) => void pull(r)} onPush={(r) => void push(r)} />}

          {state.reports.length > 0 && (
            <table className="mt-3 w-full text-left text-[11px]">
              <caption className="sr-only">État des rapports</caption>
              <thead className="text-muted">
                <tr className="border-b border-border">
                  <th scope="col" className="py-1 font-medium">Rapport</th>
                  <th scope="col" className="py-1 font-medium">Modifié</th>
                  <th scope="col" className="py-1 text-right font-medium">Par rapport à GitHub</th>
                </tr>
              </thead>
              <tbody>
                {state.reports.map((r) => (
                  <tr key={r.id} className="border-b border-border/60 last:border-0">
                    <td className="py-1 pr-2">{r.name}</td>
                    <td className="py-1 pr-2 text-muted tabular-nums">{whenLabel(r.updated_at)}</td>
                    <td className={clsx("py-1 text-right", r.state === "synced" ? "text-positive" : "text-fg")}>{STATE_LABEL[r.state]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 text-xs text-negative">
          {error}
        </p>
      )}
    </section>
  );
}

/** Compte rendu d'un envoi / d'une récupération, avec résolution des conflits (jamais d'écrasement implicite). */
function ResultBox({
  kind,
  res,
  busy,
  onPull,
  onPush,
}: {
  kind: "push" | "pull";
  res: PushResult | PullResult;
  busy: boolean;
  onPull: (r: Record<string, Resolution>) => void;
  onPush: (r: Record<string, "local">) => void;
}) {
  const lines = resultLines(res);
  return (
    <div role="status" className="mt-3 rounded-md border border-border bg-bg px-3 py-2 text-[11px]">
      <p className="font-medium">{res.message}</p>
      {lines.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-muted">
          {lines.map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      )}
      {res.conflicts.length > 0 && (
        <div className="mt-2 space-y-2">
          <p className="flex items-center gap-1 text-negative">
            <TriangleAlert className="size-3.5" aria-hidden /> Modifiés sur ce poste <em>et</em> sur GitHub depuis la dernière synchronisation : choisissez pour chacun.
          </p>
          {res.conflicts.map((c) => (
            <ConflictRow key={c.id} conflict={c} kind={kind} busy={busy} onPull={onPull} onPush={onPush} />
          ))}
        </div>
      )}
    </div>
  );
}

function ConflictRow({ conflict, kind, busy, onPull, onPush }: { conflict: Conflict; kind: "push" | "pull"; busy: boolean; onPull: (r: Record<string, Resolution>) => void; onPush: (r: Record<string, "local">) => void }) {
  const btn = "rounded border border-border px-2 py-0.5 hover:bg-surface-2 disabled:opacity-40";
  return (
    <div className="flex flex-wrap items-center gap-2 rounded border border-border/60 px-2 py-1.5">
      <span className="min-w-0 flex-1">
        <span className="font-medium text-fg">{conflict.name}</span>
        {conflict.remote_name && conflict.remote_name !== conflict.name && <span className="text-muted"> · sur GitHub : « {conflict.remote_name} »</span>}
        {conflict.remote_updated_at && <span className="text-muted"> · GitHub {whenLabel(conflict.remote_updated_at)}</span>}
        {conflict.local_updated_at && <span className="text-muted"> · poste {whenLabel(conflict.local_updated_at)}</span>}
      </span>
      {kind === "pull" ? (
        <>
          <button type="button" disabled={busy} className={btn} onClick={() => onPull({ [conflict.id]: "local" })}>
            Garder ce poste
          </button>
          <button type="button" disabled={busy} className={btn} onClick={() => onPull({ [conflict.id]: "remote" })}>
            Prendre GitHub
          </button>
          <button type="button" disabled={busy} className={btn} onClick={() => onPull({ [conflict.id]: "copy" })}>
            Importer une copie
          </button>
        </>
      ) : (
        <button type="button" disabled={busy} className={btn} onClick={() => onPush({ [conflict.id]: "local" })}>
          Écraser GitHub avec ce poste
        </button>
      )}
    </div>
  );
}
