import clsx from "clsx";
import { Check, Download, FileCode2, FileImage, FileText, Loader2, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import type { DocumentFormat } from "../export/document";
import { type DocumentResult, documentPages, exportDocument } from "../export/exportDocument";
import { useTheme } from "../hooks/useTheme";
import { type SaveOutcome, saveFile } from "../lib/desktop";
import { useStudioData } from "./context";
import { useStudio } from "./store";

const FORMATS: { value: DocumentFormat; label: string; icon: typeof FileText; text: string }[] = [
  { value: "pdf", label: "PDF", icon: FileText, text: "Une page par page du rapport, à imprimer ou à envoyer." },
  { value: "png", label: "Image", icon: FileImage, text: "La page affichée en PNG haute définition." },
  { value: "html", label: "Rapport HTML", icon: FileCode2, text: "Un seul fichier, lisible partout hors ligne : pages, filtres et données de chaque visuel." },
];

/** Export PDF, image ou rapport HTML autonome de la page affichée ou de tout le rapport. */
export function DocumentDialog({ initial, onClose }: { initial: DocumentFormat; onClose: () => void }) {
  const report = useStudio((s) => s.report);
  const pageId = useStudio((s) => s.pageId);
  const selection = useStudio((s) => s.selection);
  const extraction = useStudio((s) => s.extraction);
  const { profiles } = useStudioData();
  const { theme: appMode } = useTheme();
  const [format, setFormat] = useState<DocumentFormat>(initial);
  const [pages, setPages] = useState<"all" | "current">("all");
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<DocumentResult | null>(null);
  const [saved, setSaved] = useState<SaveOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const titleId = useId();
  const running = progress !== null && result === null && error === null;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (running) abort.current?.abort();
      else onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [running, onClose]);
  useEffect(() => () => abort.current?.abort(), []);

  if (!report) return null;
  const page = report.pages.find((p) => p.id === pageId);
  const count = documentPages(report, pageId, pages, format).length;

  const save = (res: DocumentResult) =>
    saveFile(res.blob, res.fileName).then(setSaved, (e: unknown) => {
      setSaved({ kind: "cancelled" });
      setError(e instanceof Error ? e.message : String(e));
    });

  const run = async () => {
    abort.current = new AbortController();
    setError(null);
    setResult(null);
    setSaved(null);
    setProgress({ done: 0, total: count });
    try {
      const res = await exportDocument({
        report,
        pageId,
        selection,
        extraction,
        profiles,
        appMode,
        format,
        pages,
        onProgress: (done, total) => setProgress({ done, total }),
        signal: abort.current.signal,
      });
      setResult(res);
      await save(res);
    } catch (err) {
      if ((err as Error).name === "AbortError") setProgress(null);
      else setError(err instanceof Error ? err.message : String(err));
    }
  };

  const percent = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && !running && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="atelier-pop w-full max-w-md rounded-xl border border-border bg-surface text-fg shadow-2xl">
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Download className="size-4 text-accent-ink" aria-hidden />
          <h2 id={titleId} className="flex-1 text-sm font-semibold">
            Exporter en PDF, image ou HTML
          </h2>
          <button type="button" onClick={onClose} disabled={running} aria-label="Fermer" className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-30">
            <X className="size-4" aria-hidden />
          </button>
        </header>

        <div className={clsx("space-y-4 px-4 py-4", running && "pointer-events-none opacity-60")}>
          <div role="radiogroup" aria-label="Format" className="grid grid-cols-3 gap-2">
            {FORMATS.map((f) => (
              <button
                key={f.value}
                type="button"
                role="radio"
                aria-checked={format === f.value}
                onClick={() => {
                  setFormat(f.value);
                  setResult(null);
                }}
                className={clsx("flex flex-col items-start gap-1 rounded-lg border p-2.5 text-left", format === f.value ? "border-accent-ink bg-accent-soft" : "border-border hover:bg-accent-faint")}
              >
                <span className="flex items-center gap-1.5 text-xs font-medium">
                  <f.icon className="size-4 text-accent-ink" aria-hidden /> {f.label}
                </span>
                <span className="text-[11px] leading-snug text-muted">{f.text}</span>
              </button>
            ))}
          </div>
          {format !== "png" && (
            <div className="flex rounded-md border border-border p-0.5 text-xs" role="group" aria-label="Pages">
              {(["all", "current"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={pages === v}
                  onClick={() => {
                    setPages(v);
                    setResult(null);
                  }}
                  className={clsx("flex-1 rounded px-2 py-1", pages === v ? "bg-accent-soft font-medium text-fg" : "text-muted hover:text-fg")}
                >
                  {v === "all" ? `Toutes les pages (${documentPages(report, pageId, "all", format).length})` : `Page « ${page?.name ?? "…"} »`}
                </button>
              ))}
            </div>
          )}
          <p className="flex items-start gap-1.5 text-[11px] text-muted">
            <ShieldCheck className="mt-px size-3 shrink-0" aria-hidden />
            Le fichier est créé sur cet ordinateur : aucune donnée n'est envoyée. Filtres, segments et sélection actifs sont appliqués
            {format === "png" ? "." : " ; les pages d'extraction ne sont pas reprises."}
          </p>
        </div>

        {running && progress && (
          <div className="px-4 pb-3" role="status" aria-live="polite">
            <div className="mb-1 flex justify-between text-[11px] text-muted">
              <span>Capture des pages</span>
              <span className="tabular-nums">
                {progress.done} / {progress.total}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${percent}%` }} />
            </div>
          </div>
        )}
        {result && !error && (
          <p role="status" className="mx-4 mb-3 flex items-center gap-1.5 rounded-md bg-positive/10 px-2.5 py-2 text-xs text-positive">
            <Check className="size-3.5" aria-hidden />
            {saved?.kind === "saved" ? `Enregistré : ${saved.path}` : saved?.kind === "cancelled" ? "Enregistrement annulé." : `« ${result.fileName} » téléchargé (${result.pages} page${result.pages > 1 ? "s" : ""}).`}
          </p>
        )}
        {error && (
          <p role="alert" className="mx-4 mb-3 flex items-start gap-1.5 rounded-md bg-negative/10 px-2.5 py-2 text-xs text-negative">
            <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden /> {error}
          </p>
        )}

        <footer className="flex justify-end gap-2 border-t border-border px-4 py-3">
          {running ? (
            <button type="button" onClick={() => abort.current?.abort()} className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-surface-2">
              <Loader2 className="size-3.5 animate-spin" aria-hidden /> Annuler
            </button>
          ) : (
            <>
              <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-fg">
                Fermer
              </button>
              {result ? (
                <button type="button" onClick={() => void save(result)} className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs hover:bg-surface-2">
                  <Download className="size-3.5" aria-hidden /> Enregistrer de nouveau
                </button>
              ) : null}
              <button type="button" onClick={() => void run()} className="atelier-btn-primary flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg hover:brightness-110">
                <Download className="size-3.5" aria-hidden /> Exporter
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
