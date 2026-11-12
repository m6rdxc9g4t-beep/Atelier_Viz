import clsx from "clsx";
import { ArrowLeft, Bookmark, Check, CircleHelp, Download, Eye, FileCode2, FileImage, FileText, FilterX, Loader2, MonitorPlay, Palette, Pencil, Presentation, Redo2, ScrollText, Sparkles, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useLinkedProfiles } from "../hooks/useDatasetProfiles";
import { ApiError, api } from "../lib/api";
import { navigate } from "../lib/router";
import { isNarrowScreen } from "../lib/viewport";
import type { DatasetSummary } from "../types/dataset";
import { Canvas } from "./Canvas";
import { StudioDataContext } from "./context";
import { ContextMenu } from "./ContextMenu";
import { DocumentDialog } from "./DocumentDialog";
import { ExportDialog } from "./ExportDialog";
import { extractionLabel } from "./extraction";
import { PageTabs } from "./PageTabs";
import { ExtractionBar, Presentation as PresentationMode } from "./Presentation";
import { AIBuilderPane } from "./panes/AIBuilderPane";
import { AskPane } from "./panes/AskPane";
import { BookmarksPane } from "./panes/BookmarksPane";
import { SummaryPane } from "./panes/SummaryPane";
import { DataPane } from "./panes/DataPane";
import { FiltersPane } from "./panes/FiltersPane";
import { ThemePane } from "./panes/ThemePane";
import { VisualizationsPane } from "./panes/VisualizationsPane";
import { bodyOf, useStudio } from "./store";
import { readTheme, themeVars } from "../theme/reportTheme";

const AUTOSAVE_MS = 800;
/** Nouvel essai d'enregistrement quand le serveur local ne répondait pas. */
const RETRY_MS = 5000;

/** Éditeur de rapport : canvas + volets, sauvegarde automatique, raccourcis clavier. */
export function StudioPage({ reportId }: { reportId: string }) {
  const report = useStudio((s) => s.report);
  const pageId = useStudio((s) => s.pageId);
  const mode = useStudio((s) => s.mode);
  const saveState = useStudio((s) => s.saveState);
  const saveError = useStudio((s) => s.saveError);
  const notice = useStudio((s) => s.notice);
  const selection = useStudio((s) => s.selection);
  const canUndo = useStudio((s) => s.past.length > 0);
  const canRedo = useStudio((s) => s.future.length > 0);
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [activeDatasetId, setActiveDatasetId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Volets de droite : édition classique, thème, ou création par l'IA.
  const [side, setSide] = useState<"default" | "theme" | "ai" | "summary" | "bookmarks" | "ask">("default");
  const toggleSide = (v: "theme" | "ai" | "summary" | "bookmarks" | "ask") => setSide((cur) => (cur === v ? "default" : v));
  const [exporting, setExporting] = useState(false);
  const [exportMenu, setExportMenu] = useState<{ x: number; y: number } | null>(null);
  const [documentFormat, setDocumentFormat] = useState<"pdf" | "png" | "html" | null>(null);
  const extraction = useStudio((st) => st.extraction);
  // Présentation : mode lecture plein écran ; le mode d'avant est rétabli en sortant.
  const [presenting, setPresenting] = useState<null | "edit" | "view">(null);
  const presentingRef = useRef(presenting);
  presentingRef.current = presenting;
  const s = useStudio.getState;
  const startPresenting = () => {
    setPresenting(s().mode);
    s().setMode("view");
  };
  const stopPresenting = useCallback(() => {
    const previous = presentingRef.current;
    if (previous) useStudio.getState().setMode(previous);
    setPresenting(null);
  }, []);

  // Chargement
  useEffect(() => {
    let alive = true;
    Promise.all([api.reports.get(reportId), api.datasets.list()])
      .then(([r, list]) => {
        if (!alive) return;
        s().load(r);
        // Téléphone : le rapport s'ouvre en lecture, la page occupe l'écran (l'édition reste à un geste).
        if (isNarrowScreen()) s().setMode("view");
        setDatasets(list);
        const used = r.pages.flatMap((p) => p.visuals).find((v) => v.dataset_id)?.dataset_id;
        setActiveDatasetId(r.dataset_id ?? used ?? list[0]?.id ?? null);
      })
      .catch((e: unknown) => alive && setLoadError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [reportId, s]);

  // Sauvegarde automatique (après une pause de saisie). Serveur local injoignable (redémarrage) : nouvel essai tout
  // seul, sans attendre une autre modification ; un refus du serveur (4xx, 5xx) n'est pas rejoué.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unreachable = useRef(false);
  useEffect(() => {
    const retry = saveState === "error" && unreachable.current;
    if ((saveState !== "dirty" && !retry) || !report) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(
      () => {
        const snapshot = s().report;
        if (!snapshot) return;
        s().setSaveState("saving");
        api.reports
          .save(snapshot.id, bodyOf(snapshot))
          .then(() => {
            if (s().report === snapshot) s().setSaveState("saved");
            else s().setSaveState("dirty");
          })
          .catch((e: unknown) => {
            unreachable.current = e instanceof ApiError && e.status === 0;
            s().setSaveState("error", e instanceof Error ? e.message : String(e));
          });
      },
      retry ? RETRY_MS : AUTOSAVE_MS,
    );
  }, [report, saveState, s]);

  // Fenêtre fermée ou rechargée avant la fin de la pause (ou pendant l'envoi) : le dernier état part quand même.
  useEffect(() => {
    const flush = () => {
      const { report: current, saveState: state } = s();
      if (!current || state === "saved") return;
      if (timer.current) clearTimeout(timer.current);
      api.reports.save(current.id, bodyOf(current), true).catch(() => undefined);
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [s]);

  // Raccourcis clavier
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable]")) return;
      // Touche tapée dans un menu ou un dialogue : elle leur appartient, jamais au visuel sélectionné derrière.
      if (target.closest('[role="menu"], [role="dialog"]')) return;
      const st = s();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) st.redo();
        else st.undo();
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        st.redo();
      } else if (mod && e.key.toLowerCase() === "d" && st.selectedId) {
        e.preventDefault();
        st.duplicateVisual(st.selectedId);
      } else if ((e.key === "Delete" || e.key === "Backspace") && st.selectedId && st.mode === "edit") {
        e.preventDefault();
        st.removeVisual(st.selectedId);
      } else if (e.key.startsWith("Arrow") && st.selectedId && st.mode === "edit" && !mod) {
        // Ajustement au pixel près (Maj : 10 px).
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        const [dx, dy] = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key] ?? [0, 0];
        if (dx || dy) st.nudge(st.selectedId, dx ?? 0, dy ?? 0);
      } else if (e.key === "Escape") {
        if (st.selection) st.setSelection(null);
        else st.select(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [s]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => s().notify(null), 4000);
    return () => clearTimeout(t);
  }, [notice, s]);

  const usedIds = useMemo(
    () => [activeDatasetId, ...(report?.pages.flatMap((p) => p.visuals.map((v) => v.dataset_id)) ?? [])],
    [report, activeDatasetId],
  );
  const profiles = useLinkedProfiles(usedIds);

  if (loadError) {
    return (
      <div className="p-8 text-sm text-negative">
        {loadError}{" "}
        <button type="button" className="text-accent-ink underline" onClick={() => navigate("/")}>
          Retour aux rapports
        </button>
      </div>
    );
  }
  if (!report || report.id !== reportId) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted" aria-label="Chargement du rapport" />
      </div>
    );
  }
  const page = report.pages.find((p) => p.id === pageId) ?? report.pages[0];
  const editing = mode === "edit";
  // Thème du rapport : classe de base (clair / sombre) + variables CSS, posés sur la page seulement
  // (les volets restent au design system). `text-fg` : l'encre héritée part du thème du rapport,
  // pas de celle de <body> (sinon un texte sans couleur explicite garde l'encre de l'application).
  const theme = readTheme(report.theme);

  return (
    <StudioDataContext.Provider value={{ datasets, profiles, activeDatasetId, setActiveDatasetId }}>
      <div className="flex h-full flex-col">
        {/* Écran étroit : la barre défile en largeur, toutes les actions restent atteignables. */}
        <div className="flex h-(--top-h) shrink-0 items-center gap-2 border-b border-line bg-bg px-3 max-md:overflow-x-auto max-md:[scrollbar-width:none] max-md:[&>*]:shrink-0">
          <button type="button" onClick={() => navigate("/")} aria-label="Retour aux rapports" className="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg">
            <ArrowLeft className="size-4" aria-hidden />
          </button>
          <input
            aria-label="Nom du rapport"
            // Barre étroite : le nom s'abrège par « … » (au lieu d'être coupé net) et reste lisible en info-bulle.
            title={report.name}
            value={report.name}
            readOnly={!editing}
            onChange={(e) => s().mutate((r) => (r.name = e.target.value || "Sans titre"))}
            className="min-w-0 max-w-72 flex-1 truncate rounded-md px-1.5 py-1 text-sm font-semibold hover:bg-surface-2 focus:bg-field max-md:w-36 max-md:flex-none"
          />
          <SaveBadge state={saveState} error={saveError} />
          <div className="ml-auto flex items-center gap-1">
            {selection && (
              <button type="button" onClick={() => s().setSelection(null)} className="flex h-7 items-center gap-1 rounded-md bg-accent-soft px-2 text-xs font-medium text-accent-ink">
                <X className="size-3" aria-hidden /> Sélection
              </button>
            )}
            <button type="button" onClick={() => s().resetFilters()} title="Réinitialiser segments, filtres de page et sélection" className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted hover:bg-surface-2 hover:text-fg">
              <FilterX className="size-3.5" aria-hidden /> <span className="hidden md:inline">Réinitialiser</span>
            </button>
            {editing && (
              <button
                type="button"
                onClick={() => toggleSide("ai")}
                aria-pressed={side === "ai"}
                className={clsx(
                  "flex h-7 items-center gap-1 rounded-md px-2 text-xs whitespace-nowrap",
                  side === "ai" ? "bg-surface-3 text-fg" : "text-muted hover:bg-surface-2 hover:text-fg",
                )}
              >
                <Sparkles className="size-3.5" aria-hidden /> Créer avec l'IA
              </button>
            )}
            {editing && (
              <button
                type="button"
                onClick={() => toggleSide("theme")}
                aria-pressed={side === "theme"}
                className={clsx("flex h-7 items-center gap-1 rounded-md px-2 text-xs", side === "theme" ? "bg-surface-3 text-fg" : "text-muted hover:bg-surface-2 hover:text-fg")}
              >
                <Palette className="size-3.5" aria-hidden /> <span className="hidden md:inline">Thème</span>
              </button>
            )}
            {editing && (
              <>
                <button type="button" disabled={!canUndo} onClick={() => s().undo()} aria-label="Annuler (Ctrl+Z)" title="Annuler (Ctrl+Z)" className="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-30">
                  <Undo2 className="size-4" aria-hidden />
                </button>
                <button type="button" disabled={!canRedo} onClick={() => s().redo()} aria-label="Rétablir (Ctrl+Y)" title="Rétablir (Ctrl+Y)" className="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-30">
                  <Redo2 className="size-4" aria-hidden />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => toggleSide("bookmarks")}
              aria-pressed={side === "bookmarks"}
              title="Signets : enregistrer et rappeler un état du rapport (page, filtres, segments)"
              className={clsx("flex h-7 items-center gap-1 rounded-md px-2 text-xs", side === "bookmarks" ? "bg-surface-3 text-fg" : "text-muted hover:bg-surface-2 hover:text-fg")}
            >
              <Bookmark className="size-3.5" aria-hidden /> <span className="hidden md:inline">Signets</span>
            </button>
            <button
              type="button"
              onClick={() => toggleSide("ask")}
              aria-pressed={side === "ask"}
              title="Poser une question en français : un visuel et une réponse aux chiffres vérifiés"
              className={clsx("flex h-7 items-center gap-1 rounded-md px-2 text-xs", side === "ask" ? "bg-surface-3 text-fg" : "text-muted hover:bg-surface-2 hover:text-fg")}
            >
              <CircleHelp className="size-3.5" aria-hidden /> <span className="hidden md:inline">Demander</span>
            </button>
            <button
              type="button"
              onClick={() => toggleSide("summary")}
              aria-pressed={side === "summary"}
              title="Synthèse de la page par l'IA, chiffres vérifiés"
              className={clsx("flex h-7 items-center gap-1 rounded-md px-2 text-xs", side === "summary" ? "bg-surface-3 text-fg" : "text-muted hover:bg-surface-2 hover:text-fg")}
            >
              <ScrollText className="size-3.5" aria-hidden /> <span className="hidden md:inline">Résumer</span>
            </button>
            <button
              type="button"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setExportMenu({ x: r.left, y: r.bottom + 4 });
              }}
              aria-haspopup="menu"
              aria-expanded={exportMenu !== null}
              title="Exporter : PowerPoint, PDF, image ou rapport HTML"
              className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted hover:bg-surface-2 hover:text-fg"
            >
              <Download className="size-3.5" aria-hidden /> <span className="hidden md:inline">Exporter</span>
            </button>
            <button
              type="button"
              onClick={startPresenting}
              title="Présenter en plein écran : flèches pour changer de page, diaporama de pages ou de signets, Échap pour quitter"
              className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted hover:bg-surface-2 hover:text-fg"
            >
              <MonitorPlay className="size-3.5" aria-hidden /> <span className="hidden md:inline">Présenter</span>
            </button>
            <div className="ml-1 flex rounded-md bg-surface-2 p-0.5 text-xs" role="group" aria-label="Mode">
              {(["edit", "view"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={mode === m}
                  onClick={() => s().setMode(m)}
                  className={clsx(
                    "flex h-6 items-center gap-1 rounded-sm px-2",
                    mode === m ? "bg-surface font-medium text-fg shadow-[0_1px_2px_rgb(0_0_0/0.08),0_0_0_1px_var(--line)]" : "text-muted hover:text-fg",
                  )}
                >
                  {m === "edit" ? <Pencil className="size-3" aria-hidden /> : <Eye className="size-3" aria-hidden />}
                  {m === "edit" ? "Édition" : "Lecture"}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="relative flex min-h-0 flex-1">
          <section
            className={clsx("relative min-w-0 flex-1 overflow-hidden bg-canvas text-fg", theme && (theme.mode === "dark" ? "theme-dark" : "theme-light"))}
            data-theme={theme?.mode}
            style={theme ? themeVars(theme) : undefined}
            aria-label={`Page ${page?.name ?? ""}`}
          >
            {page && !presenting && <Canvas page={page} report={report} />}
            {extraction && extraction.pageId === page?.id && !presenting && (
              <ExtractionBar label={extractionLabel(extraction.filters)} from={report.pages.find((p) => p.id === extraction.fromPageId)?.name ?? ""} />
            )}
          </section>
          {side === "summary" && <SummaryPane />}
          {side === "ask" && <AskPane />}
          {side === "bookmarks" && <BookmarksPane />}
          {editing && side === "theme" && <ThemePane />}
          {editing && side === "ai" && (
            <>
              <AIBuilderPane />
              <DataPane />
            </>
          )}
          {editing && side === "default" && (
            <>
              <FiltersPane />
              <VisualizationsPane />
              <DataPane />
            </>
          )}
          {notice && (
            <div role="status" className="atelier-pop absolute bottom-3 left-1/2 z-30 -translate-x-1/2 rounded-md border bg-surface px-3 py-2 text-xs text-fg">
              {notice}
            </div>
          )}
        </div>
        <PageTabs />
      </div>
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
      {exportMenu && (
        <ContextMenu
          x={exportMenu.x}
          y={exportMenu.y}
          title="Exporter"
          onClose={() => setExportMenu(null)}
          items={[
            { label: "PowerPoint (.pptx)", hint: "Graphiques modifiables", icon: Presentation, onSelect: () => setExporting(true) },
            { label: "PDF", hint: "Une page par page du rapport", icon: FileText, onSelect: () => setDocumentFormat("pdf") },
            { label: "Image (PNG)", hint: "La page affichée", icon: FileImage, onSelect: () => setDocumentFormat("png") },
            { label: "Rapport HTML autonome", hint: "Un fichier lisible partout, avec les données", icon: FileCode2, onSelect: () => setDocumentFormat("html") },
          ]}
        />
      )}
      {documentFormat && <DocumentDialog initial={documentFormat} onClose={() => setDocumentFormat(null)} />}
      {presenting && <PresentationMode report={report} onExit={stopPresenting} />}
    </StudioDataContext.Provider>
  );
}

function SaveBadge({ state, error }: { state: string; error: string | null }) {
  if (state === "error") return <span className="text-xs text-negative" title={error ?? ""}>Échec de l'enregistrement</span>;
  if (state === "saving" || state === "dirty")
    return (
      <span className="flex items-center gap-1 text-xs text-muted">
        <Loader2 className="size-3 animate-spin" aria-hidden /> <span className="max-sm:sr-only">Enregistrement…</span>
      </span>
    );
  return (
    <span className="flex items-center gap-1 text-xs text-muted">
      <Check className="size-3" aria-hidden /> <span className="max-sm:sr-only">Enregistré</span>
    </span>
  );
}
