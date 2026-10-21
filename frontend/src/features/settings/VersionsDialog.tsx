import clsx from "clsx";
import { Copy, ExternalLink, History, Loader2, RotateCcw, TriangleAlert, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";

import { api } from "../../lib/api";
import { openExternal } from "../../lib/desktop";
import type { ReportVersion, ReportVersionDetail, RestoreResult } from "../../types/github";
import { whenLabel } from "../automation/schedule";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Historique GitHub d'un rapport : commits qui l'ont modifié, aperçu d'une version, restauration sur ce
 * poste (ou en copie). Rien n'est envoyé : le retour en arrière se publie au prochain « Envoyer ».
 */
export function VersionsDialog({ report, onClose, onRestored }: { report: { id: string; name: string }; onClose: () => void; onRestored: (r: RestoreResult) => void }) {
  const titleId = useId();
  const [versions, setVersions] = useState<ReportVersion[] | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReportVersionDetail | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.github
      .history(report.id)
      .then((v) => {
        setVersions(v);
        setPicked(v[0]?.sha ?? null);
      })
      .catch((e: unknown) => setError(message(e)));
  }, [report.id]);

  useEffect(() => {
    setDetail(null);
    setConfirm(false);
    if (!picked) return;
    let alive = true;
    api.github
      .version(report.id, picked)
      .then((d) => alive && setDetail(d))
      .catch((e: unknown) => alive && setError(message(e)));
    return () => {
      alive = false;
    };
  }, [picked, report.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const restore = async (asCopy: boolean) => {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      onRestored(await api.github.restore(report.id, { sha: picked, as_copy: asCopy }));
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };

  const index = versions?.findIndex((v) => v.sha === picked) ?? -1;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="atelier-pop flex max-h-[88vh] w-full max-w-2xl flex-col rounded-xl border border-border bg-surface text-fg shadow-2xl">
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <History className="size-4 text-accent-ink" aria-hidden />
          <h2 id={titleId} className="flex-1 truncate text-sm font-semibold">
            Historique GitHub · {report.name}
          </h2>
          <button type="button" onClick={onClose} aria-label="Fermer" className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg">
            <X className="size-4" aria-hidden />
          </button>
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-1 sm:grid-cols-[minmax(0,1fr)_15rem]">
          <ol className="min-h-48 overflow-y-auto border-border p-2 sm:border-r" aria-label="Versions">
            {!versions && !error && (
              <li className="p-3">
                <Loader2 className="size-4 animate-spin text-muted" aria-label="Chargement" />
              </li>
            )}
            {versions?.length === 0 && <li className="p-3 text-xs text-muted">Ce rapport n'a jamais été envoyé sur cette branche.</li>}
            {versions?.map((v, i) => (
              <li key={v.sha}>
                <button
                  type="button"
                  onClick={() => setPicked(v.sha)}
                  aria-current={picked === v.sha ? "true" : undefined}
                  className={clsx("flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left text-xs", picked === v.sha ? "bg-accent-soft" : "hover:bg-accent-faint")}
                >
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-medium">{v.message || "(sans message)"}</span>
                    {i === 0 && <span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted">dernière</span>}
                  </span>
                  <span className="text-[11px] text-muted">
                    {v.date ? whenLabel(v.date) : "—"}
                    {v.author ? ` · ${v.author}` : ""} · <span className="font-mono">{v.sha.slice(0, 7)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
          <aside className="space-y-3 p-3 text-xs" aria-label="Version choisie">
            {picked && !detail && !error && <Loader2 className="size-4 animate-spin text-muted" aria-label="Chargement de la version" />}
            {detail && (
              <>
                <div>
                  <p className="text-[11px] text-muted">Version {detail.sha.slice(0, 7)}</p>
                  <p className="font-medium">{detail.name}</p>
                  <p className="text-[11px] text-muted">
                    {detail.pages.length} page{detail.pages.length > 1 ? "s" : ""} · {detail.visuals} visuel{detail.visuals > 1 ? "s" : ""}
                    {detail.updated_at ? ` · modifié ${whenLabel(detail.updated_at)}` : ""}
                  </p>
                  <ul className="mt-1 list-inside list-disc text-[11px] text-muted">
                    {detail.pages.slice(0, 8).map((p, i) => (
                      <li key={i} className="truncate">
                        {p}
                      </li>
                    ))}
                  </ul>
                </div>
                {versions?.[index]?.url && (
                  <button type="button" onClick={() => openExternal(versions[index]?.url ?? "")} className="flex items-center gap-1 text-[11px] text-accent-ink hover:underline">
                    Voir le commit <ExternalLink className="size-3" aria-hidden />
                  </button>
                )}
                {confirm ? (
                  <div className="space-y-2 rounded-md border border-border p-2">
                    <p className="flex items-start gap-1.5 text-[11px]">
                      <TriangleAlert className="mt-px size-3.5 shrink-0 text-accent-ink" aria-hidden />
                      Le rapport de ce poste sera remplacé par cette version (vos filtres et sélections sont gardés). Pour publier ce retour en arrière, envoyez-le ensuite.
                    </p>
                    <div className="flex gap-2">
                      <button type="button" disabled={busy} onClick={() => void restore(false)} className="atelier-btn-primary flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg disabled:opacity-40">
                        {busy && <Loader2 className="size-3 animate-spin" aria-hidden />} Restaurer
                      </button>
                      <button type="button" onClick={() => setConfirm(false)} className="rounded-md px-2.5 py-1 text-xs text-muted hover:bg-surface-2">
                        Annuler
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    <button type="button" disabled={busy} onClick={() => setConfirm(true)} className="flex items-center justify-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-surface-2 disabled:opacity-40">
                      <RotateCcw className="size-3.5" aria-hidden /> Restaurer cette version
                    </button>
                    <button type="button" disabled={busy} onClick={() => void restore(true)} className="flex items-center justify-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-surface-2 disabled:opacity-40">
                      <Copy className="size-3.5" aria-hidden /> Restaurer en copie
                    </button>
                  </div>
                )}
              </>
            )}
            {error && (
              <p role="alert" className="text-[11px] text-negative">
                {error}
              </p>
            )}
          </aside>
        </div>
      </div>
    </div>,
    document.body,
  );
}
