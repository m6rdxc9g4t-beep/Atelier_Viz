import clsx from "clsx";
import { ArrowLeft, Check, Eye, FilterX, Loader2, Palette, Pencil, Presentation, Redo2, ScrollText, Sparkles, Undo2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useDatasetProfiles } from "../hooks/useDatasetProfiles";
import { api } from "../lib/api";
import { navigate } from "../lib/router";
import type { DatasetSummary } from "../types/dataset";
import { Canvas } from "./Canvas";
import { StudioDataContext } from "./context";
import { ExportDialog } from "./ExportDialog";
import { PageTabs } from "./PageTabs";
import { AIBuilderPane } from "./panes/AIBuilderPane";
import { SummaryPane } from "./panes/SummaryPane";
import { DataPane } from "./panes/DataPane";
import { FiltersPane } from "./panes/FiltersPane";
import { ThemePane } from "./panes/ThemePane";
import { VisualizationsPane } from "./panes/VisualizationsPane";
import { bodyOf, useStudio } from "./store";
import { readTheme, themeVars } from "../theme/reportTheme";

const AUTOSAVE_MS = 800;

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
  const [side, setSide] = useState<"default" | "theme" | "ai" | "summary">("default");
  const toggleSide = (v: "theme" | "ai" | "summary") => setSide((cur) => (cur === v ? "default" : v));
  const [exporting, setExporting] = useState(false);
  const s = useStudio.getState;

  // Chargement
  useEffect(() => {
    let alive = true;
    Promise.all([api.reports.get(reportId), api.datasets.list()])
      .then(([r, list]) => {
        if (!alive) return;
        s().load(r);
        setDatasets(list);
        const used = r.pages.flatMap((p) => p.visuals).find((v) => v.dataset_id)?.dataset_id;
        setActiveDatasetId(r.dataset_id ?? used ?? list[0]?.id ?? null);
      })
      .catch((e: unknown) => alive && setLoadError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [reportId, s]);

  // Sauvegarde automatique (après une pause de saisie)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (saveState !== "dirty" || !report) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const snapshot = s().report;
      if (!snapshot) return;
      s().setSaveState("saving");
      api.reports
        .save(snapshot.id, bodyOf(snapshot))
        .then(() => {
          if (s().report === snapshot) s().setSaveState("saved");
          else s().setSaveState("dirty");
        })
        .catch((e: unknown) => s().setSaveState("error", e instanceof Error ? e.message : String(e)));
    }, AUTOSAVE_MS);
  }, [report, saveState, s]);

  // Raccourcis clavier
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable]")) return;
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
  const profiles = useDatasetProfiles(usedIds);

  if (loadError) {
    return (
      <div className="p-8 text-sm text-negative">
        {loadError}{" "}
        <button type="button" className="text-accent underline" onClick={() => navigate("/")}>
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
  // Thème du rapport : classe de base (clair / sombre) + variables CSS ; absent = suit l'application.
  const theme = readTheme(report.theme);

  return (
    <StudioDataContext.Provider value={{ datasets, profiles, activeDatasetId, setActiveDatasetId }}>
      <div className="flex h-full flex-col">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-surface px-3">
          <button type="button" onClick={() => navigate("/")} aria-label="Retour aux rapports" className="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-fg">
            <ArrowLeft className="size-4" aria-hidden />
          </button>
          <input
            aria-label="Nom du rapport"
            value={report.name}
            readOnly={!editing}
            onChange={(e) => s().mutate((r) => (r.name = e.target.value || "Sans titre"))}
            className="min-w-0 max-w-72 flex-1 rounded px-1.5 py-1 text-sm font-semibold hover:bg-surface-2 focus:bg-bg focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <SaveBadge state={saveState} error={saveError} />
          <div className="ml-auto flex items-center gap-1">
            {selection && (
              <button type="button" onClick={() => s().setSelection(null)} className="flex items-center gap-1 rounded-md bg-accent/10 px-2 py-1 text-xs text-accent hover:bg-accent/20">
                <X className="size-3" aria-hidden /> Sélection
              </button>
            )}
            <button type="button" onClick={() => s().resetFilters()} title="Réinitialiser segments, filtres de page et sélection" className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-fg">
              <FilterX className="size-3.5" aria-hidden /> <span className="hidden md:inline">Réinitialiser</span>
            </button>
            {editing && (
              <button
                type="button"
                onClick={() => toggleSide("ai")}
                aria-pressed={side === "ai"}
                className={clsx(
                  "flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium",
                  side === "ai" ? "bg-accent text-accent-fg" : "bg-accent/10 text-accent hover:bg-accent/20",
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
                className={clsx("flex items-center gap-1 rounded-md px-2 py-1 text-xs hover:bg-surface-2", side === "theme" ? "text-accent" : "text-muted hover:text-fg")}
              >
                <Palette className="size-3.5" aria-hidden /> <span className="hidden md:inline">Thème</span>
              </button>
            )}
            {editing && (
              <>
                <button type="button" disabled={!canUndo} onClick={() => s().undo()} aria-label="Annuler (Ctrl+Z)" title="Annuler (Ctrl+Z)" className="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-30">
                  <Undo2 className="size-4" aria-hidden />
                </button>
                <button type="button" disabled={!canRedo} onClick={() => s().redo()} aria-label="Rétablir (Ctrl+Y)" title="Rétablir (Ctrl+Y)" className="rounded p-1.5 text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-30">
                  <Redo2 className="size-4" aria-hidden />
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => toggleSide("summary")}
              aria-pressed={side === "summary"}
              title="Synthèse de la page par l'IA, chiffres vérifiés"
              className={clsx("flex items-center gap-1 rounded-md px-2 py-1 text-xs hover:bg-surface-2", side === "summary" ? "text-accent" : "text-muted hover:text-fg")}
            >
              <ScrollText className="size-3.5" aria-hidden /> <span className="hidden md:inline">Résumer</span>
            </button>
            <button
              type="button"
              onClick={() => setExporting(true)}
              title="Exporter le rapport en PowerPoint (.pptx)"
              className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-fg"
            >
              <Presentation className="size-3.5" aria-hidden /> <span className="hidden md:inline">PowerPoint</span>
            </button>
            <div className="ml-1 flex rounded-md border border-border p-0.5 text-xs" role="group" aria-label="Mode">
              {(["edit", "view"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={mode === m}
                  onClick={() => s().setMode(m)}
                  className={clsx("flex items-center gap-1 rounded px-2 py-1", mode === m ? "bg-surface-2 font-medium text-fg" : "text-muted hover:text-fg")}
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
            className={clsx("relative min-w-0 flex-1 overflow-hidden bg-canvas", theme && (theme.mode === "dark" ? "theme-dark" : "theme-light"))}
            style={theme ? themeVars(theme) : undefined}
            aria-label={`Page ${page?.name ?? ""}`}
          >
            {page && <Canvas page={page} report={report} />}
          </section>
          {side === "summary" && <SummaryPane />}
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
            <div role="status" className="absolute bottom-3 left-1/2 z-30 -translate-x-1/2 rounded-md bg-fg px-3 py-2 text-xs text-bg shadow-lg">
              {notice}
            </div>
          )}
        </div>
        <PageTabs />
      </div>
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
    </StudioDataContext.Provider>
  );
}

function SaveBadge({ state, error }: { state: string; error: string | null }) {
  if (state === "error") return <span className="text-xs text-negative" title={error ?? ""}>Échec de l'enregistrement</span>;
  if (state === "saving" || state === "dirty")
    return (
      <span className="flex items-center gap-1 text-xs text-muted">
        <Loader2 className="size-3 animate-spin" aria-hidden /> Enregistrement…
      </span>
    );
  return (
    <span className="flex items-center gap-1 text-xs text-muted">
      <Check className="size-3" aria-hidden /> Enregistré
    </span>
  );
}
