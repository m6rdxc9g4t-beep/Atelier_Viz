import clsx from "clsx";
import { Check, Download, ImageIcon, Loader2, Presentation, ShieldCheck, SquarePen, TriangleAlert, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import {
  DEFAULT_EXPORT_OPTIONS,
  type ExportOptions,
  type ExportProgress,
  type ExportResult,
  downloadBlob,
  exportReport,
} from "../export/exportReport";
import { useTheme } from "../hooks/useTheme";
import { useStudioData } from "./context";
import { useEngine } from "./panes/EnginePicker";
import { useStudio } from "./store";

const STORAGE_KEY = "atelier.export.options";

function readOptions(): ExportOptions {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...DEFAULT_EXPORT_OPTIONS, ...(JSON.parse(raw) as Partial<ExportOptions>) } : DEFAULT_EXPORT_OPTIONS;
  } catch {
    return DEFAULT_EXPORT_OPTIONS;
  }
}

function saveOptions(o: ExportOptions): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(o));
  } catch {
    /* stockage indisponible (navigation privée) : on garde les options en mémoire */
  }
}

const STEPS: Record<ExportProgress["step"], string> = {
  data: "Calcul des visuels",
  images: "Capture des cartes et visuels spéciaux",
  summary: "Synthèse IA des pages",
  slides: "Création des diapositives",
  file: "Écriture du fichier",
};

/** Boîte « Exporter en PowerPoint » : options, progression, résumé et téléchargement. */
export function ExportDialog({ onClose }: { onClose: () => void }) {
  const report = useStudio((s) => s.report);
  const pageId = useStudio((s) => s.pageId);
  const selection = useStudio((s) => s.selection);
  const { profiles } = useStudioData();
  const { theme: appMode } = useTheme();
  const engine = useEngine();
  const [options, setOptions] = useState<ExportOptions>(readOptions);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const titleId = useId();
  const firstField = useRef<HTMLButtonElement>(null);
  const running = progress !== null && result === null && error === null;

  useEffect(() => firstField.current?.focus(), []);
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
  const set = (patch: Partial<ExportOptions>) =>
    setOptions((o) => {
      const next = { ...o, ...patch };
      saveOptions(next);
      return next;
    });

  const run = async () => {
    abort.current = new AbortController();
    setError(null);
    setResult(null);
    setProgress({ step: "data", done: 0, total: 1 });
    try {
      const res = await exportReport({
        report,
        pageId,
        selection,
        profiles,
        appMode,
        options,
        aiProvider: engine.provider,
        onProgress: setProgress,
        signal: abort.current.signal,
      });
      setResult(res);
      downloadBlob(res.blob, res.fileName);
    } catch (err) {
      if ((err as Error).name === "AbortError") setProgress(null);
      else setError(err instanceof Error ? err.message : String(err));
    }
  };

  const percent = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && !running && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="w-full max-w-md rounded-xl border border-border bg-surface text-fg shadow-2xl">
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Presentation className="size-4 text-accent" aria-hidden />
          <h2 id={titleId} className="flex-1 text-sm font-semibold">
            Exporter en PowerPoint
          </h2>
          <button type="button" onClick={onClose} disabled={running} aria-label="Fermer" className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-30">
            <X className="size-4" aria-hidden />
          </button>
        </header>

        {result ? (
          <Summary result={result} onDownload={() => downloadBlob(result.blob, result.fileName)} onClose={onClose} />
        ) : (
          <>
            <div className={clsx("space-y-4 px-4 py-4", running && "pointer-events-none opacity-60")}>
              <Field label="Pages">
                <Segmented
                  value={options.pages}
                  onChange={(pages) => set({ pages })}
                  items={[
                    { value: "all", label: `Toutes (${report.pages.length})` },
                    { value: "current", label: `Page « ${page?.name ?? "…"} »` },
                  ]}
                  firstRef={firstField}
                />
              </Field>

              <Field label="Visuels">
                <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Visuels">
                  <Choice
                    checked={options.mode === "native"}
                    onSelect={() => set({ mode: "native" })}
                    icon={<SquarePen className="size-4" aria-hidden />}
                    title="Modifiables"
                    text="Graphiques et tableaux PowerPoint : valeurs, couleurs et textes se modifient dans PowerPoint."
                  />
                  <Choice
                    checked={options.mode === "image"}
                    onSelect={() => set({ mode: "image" })}
                    icon={<ImageIcon className="size-4" aria-hidden />}
                    title="Images"
                    text="Copie fidèle de l'écran, non modifiable."
                  />
                </div>
                {options.mode === "native" && (
                  <p className="mt-1.5 text-[11px] text-muted">Cartes, treemap, entonnoir, cascade, jauge et carte de chaleur sont insérés en image.</p>
                )}
              </Field>

              <Field label="Mise en page">
                <div className="space-y-1.5">
                  <Toggle checked={options.titleSlide} onChange={(titleSlide) => set({ titleSlide })} label="Diapositive de titre (nom du rapport, source, date)" />
                  <Toggle checked={options.pageTitles} onChange={(pageTitles) => set({ pageTitles })} label="Nom de la page en titre de diapositive" />
                  <Toggle
                    checked={options.fit === "split"}
                    onChange={(on) => set({ fit: on ? "split" : "fit" })}
                    label="Répartir les pages très longues sur plusieurs diapositives"
                  />
                  <Toggle
                    checked={options.aiNotes && !engine.down}
                    disabled={engine.down}
                    onChange={(aiNotes) => set({ aiNotes })}
                    label="Synthèse de chaque page par l'IA dans les notes du présentateur"
                    hint={
                      engine.down
                        ? `${engine.label} n'est pas disponible (voir Réglages).`
                        : `Par ${engine.label}, environ 5 s par page. Seuls des chiffres agrégés sont envoyés ; chaque chiffre de la synthèse est vérifié.`
                    }
                  />
                </div>
              </Field>

              <p className="flex items-start gap-1.5 text-[11px] text-muted">
                <ShieldCheck className="mt-px size-3 shrink-0" aria-hidden />
                {options.aiNotes && !engine.down
                  ? engine.label === "Claude"
                    ? "Le fichier est créé sur cet ordinateur ; pour les synthèses, seuls des chiffres agrégés sont envoyés à Claude. "
                    : "Le fichier est créé sur cet ordinateur ; les synthèses sont rédigées par Ollama, sur cette machine. "
                  : "Le fichier est créé sur cet ordinateur : aucune donnée n'est envoyée. "}
                Les filtres et segments actifs sont appliqués et listés dans les notes.
              </p>
            </div>

            {running && progress && (
              <div className="px-4 pb-3" role="status" aria-live="polite">
                <div className="mb-1 flex justify-between text-[11px] text-muted">
                  <span>{STEPS[progress.step]}</span>
                  <span className="tabular-nums">{progress.total > 1 ? `${progress.done} / ${progress.total}` : ""}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                  <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${progress.step === "file" ? 100 : percent}%` }} />
                </div>
              </div>
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
                  <button type="button" onClick={() => void run()} className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg hover:brightness-110">
                    <Download className="size-3.5" aria-hidden /> Exporter
                  </button>
                </>
              )}
            </footer>
          </>
        )}
      </div>
    </div>
  );
}

function Summary({ result, onDownload, onClose }: { result: ExportResult; onDownload: () => void; onClose: () => void }) {
  const kb = result.blob.size / 1024;
  const size = kb > 1024 ? `${(kb / 1024).toFixed(1).replace(".", ",")} Mo` : `${Math.round(kb)} Ko`;
  return (
    <>
      <div className="space-y-3 px-4 py-4" role="status">
        <p className="flex items-center gap-2 text-sm font-medium">
          <span className="flex size-6 items-center justify-center rounded-full bg-positive/15 text-positive">
            <Check className="size-3.5" aria-hidden />
          </span>
          {result.fileName}
        </p>
        <dl className="grid grid-cols-3 gap-2 text-center">
          <Stat value={result.slides} label={`diapositive${result.slides > 1 ? "s" : ""}`} />
          <Stat value={result.nativeVisuals} label="modifiables" />
          <Stat value={result.imageVisuals} label="en image" />
        </dl>
        <p className="text-[11px] text-muted">
          {size} · enregistré dans votre dossier Téléchargements. Ouvrez-le avec PowerPoint, Keynote ou LibreOffice.
        </p>
        {result.warnings.length > 0 && (
          <details className="text-[11px] text-muted">
            <summary className="cursor-pointer">
              {result.warnings.length} remarque{result.warnings.length > 1 ? "s" : ""}
            </summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {result.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <footer className="flex justify-end gap-2 border-t border-border px-4 py-3">
        <button type="button" onClick={onDownload} className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-fg">
          <Download className="size-3.5" aria-hidden /> Télécharger à nouveau
        </button>
        <button type="button" onClick={onClose} className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg hover:brightness-110">
          Terminé
        </button>
      </footer>
    </>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-md bg-surface-2 px-2 py-2">
      <dt className="sr-only">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
      <dd className="text-[10px] text-muted">{label}</dd>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">{label}</p>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  items,
  firstRef,
}: {
  value: T;
  onChange: (v: T) => void;
  items: { value: T; label: string }[];
  firstRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  return (
    <div className="grid grid-flow-col gap-1 rounded-md border border-border p-0.5 text-xs" role="radiogroup">
      {items.map((it, i) => (
        <button
          key={it.value}
          ref={i === 0 ? firstRef : undefined}
          type="button"
          role="radio"
          aria-checked={value === it.value}
          onClick={() => onChange(it.value)}
          className={clsx("truncate rounded px-2 py-1.5", value === it.value ? "bg-surface-2 font-medium text-fg" : "text-muted hover:text-fg")}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

function Choice({ checked, onSelect, icon, title, text }: { checked: boolean; onSelect: () => void; icon: ReactNode; title: string; text: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={clsx(
        "flex flex-col items-start gap-1 rounded-lg border p-2.5 text-left",
        checked ? "border-accent bg-accent/5" : "border-border hover:bg-surface-2",
      )}
    >
      <span className={clsx("flex items-center gap-1.5 text-xs font-medium", checked ? "text-accent" : "text-fg")}>
        {icon}
        {title}
      </span>
      <span className="text-[11px] leading-snug text-muted">{text}</span>
    </button>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled = false,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label className={clsx("flex items-start gap-2 text-xs", disabled ? "cursor-not-allowed opacity-60" : "cursor-pointer")}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 accent-[var(--accent)]" />
      <span>
        {label}
        {hint && <span className="mt-0.5 block text-[11px] text-muted">{hint}</span>}
      </span>
    </label>
  );
}
