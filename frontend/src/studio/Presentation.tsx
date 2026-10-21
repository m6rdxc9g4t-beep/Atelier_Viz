import clsx from "clsx";
import { Bookmark, ChevronLeft, ChevronRight, CornerUpLeft, Files, Pause, Play, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { Report } from "../types/report";
import { readTheme, themeVars } from "../theme/reportTheme";
import { Canvas } from "./Canvas";
import { extractionLabel, presentationPages, step } from "./extraction";
import { useStudio } from "./store";

const DELAYS = [5, 10, 20, 30, 60];
const HUD_IDLE_MS = 2500;

/**
 * Mode présentation : page entière en plein écran, flèches pour changer de page (ou de signet),
 * diaporama automatique, Échap pour quitter. Les pages d'extraction restent atteignables par clic droit.
 */
export function Presentation({ report, onExit }: { report: Report; onExit: () => void }) {
  const pageId = useStudio((s) => s.pageId);
  const extraction = useStudio((s) => s.extraction);
  const rootRef = useRef<HTMLDivElement>(null);
  const bookmarks = report.bookmarks ?? [];
  const [source, setSource] = useState<"pages" | "bookmarks">("pages");
  const [bookmarkIndex, setBookmarkIndex] = useState(-1);
  const [playing, setPlaying] = useState(false);
  const [delay, setDelay] = useState(10);
  const [hud, setHud] = useState(true);
  const pages = presentationPages(report);
  const page = report.pages.find((p) => p.id === pageId) ?? pages[0];
  const pageIndex = pages.findIndex((p) => p.id === page?.id);
  const s = useStudio.getState;

  const go = useCallback(
    (delta: number) => {
      if (source === "bookmarks" && bookmarks.length) {
        const next = step(bookmarkIndex < 0 ? (delta > 0 ? -1 : 0) : bookmarkIndex, bookmarks.length, delta);
        const b = bookmarks[next];
        if (b && s().applyBookmark(b.id)) setBookmarkIndex(next);
        return;
      }
      const target = pages[step(Math.max(0, pageIndex), pages.length, delta)];
      if (target) s().setPage(target.id);
    },
    [source, bookmarks, bookmarkIndex, pages, pageIndex, s],
  );

  // Plein écran à l'ouverture (sans effet si le navigateur le refuse : la présentation couvre la fenêtre).
  useEffect(() => {
    const el = rootRef.current;
    el?.requestFullscreen?.().catch(() => undefined);
    const onChange = () => {
      if (!document.fullscreenElement) onExit();
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => undefined);
    };
  }, [onExit]);

  // Diaporama : avance toutes les `delay` secondes (le compte repart après chaque changement).
  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => go(1), delay * 1000);
    return () => clearTimeout(t);
  }, [playing, delay, go, pageId, bookmarkIndex]);

  // Barre de commande masquée quand la souris ne bouge plus.
  useEffect(() => {
    if (!hud) return;
    const t = setTimeout(() => setHud(false), HUD_IDLE_MS);
    return () => clearTimeout(t);
  }, [hud]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, textarea, select")) return;
      const key = e.key;
      if (["ArrowRight", "PageDown", " ", "Enter"].includes(key)) go(1);
      else if (["ArrowLeft", "PageUp", "Backspace"].includes(key)) go(-1);
      else if (key === "Escape") onExit();
      else if (key.toLowerCase() === "p") setPlaying((p) => !p);
      else return;
      e.preventDefault();
      e.stopPropagation();
      setHud(true);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [go, onExit]);

  const theme = readTheme(report.theme);
  const position =
    source === "bookmarks" && bookmarks.length
      ? `Signet ${bookmarkIndex + 1 || "–"} / ${bookmarks.length}${bookmarkIndex >= 0 ? ` · ${bookmarks[bookmarkIndex]?.name ?? ""}` : ""}`
      : pageIndex >= 0
        ? `Page ${pageIndex + 1} / ${pages.length} · ${page?.name ?? ""}`
        : `${page?.name ?? ""} (extraction)`;
  const btn = "flex items-center gap-1 rounded-md px-2 py-1.5 text-white/85 hover:bg-white/15 hover:text-white";

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label="Présentation"
      className="fixed inset-0 z-50 bg-black"
      onMouseMove={() => setHud(true)}
      style={{ cursor: hud ? undefined : "none" }}
    >
      <section
        className={clsx("absolute inset-0 bg-canvas text-fg", theme && (theme.mode === "dark" ? "theme-dark" : "theme-light"))}
        data-theme={theme?.mode}
        style={theme ? themeVars(theme) : undefined}
        aria-label={`Page ${page?.name ?? ""}`}
      >
        {page && <Canvas key={page.id} page={page} report={report} fitPage />}
      </section>

      {extraction?.pageId === page?.id && extraction && (
        <ExtractionBar label={extractionLabel(extraction.filters)} from={report.pages.find((p) => p.id === extraction.fromPageId)?.name ?? ""} dark />
      )}

      <div
        className={clsx(
          "absolute bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-1 rounded-xl bg-black/75 p-1 text-xs shadow-2xl backdrop-blur transition-opacity",
          hud ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        role="toolbar"
        aria-label="Commandes de présentation"
      >
        <button type="button" className={btn} onClick={() => go(-1)} aria-label="Précédent (←)">
          <ChevronLeft className="size-4" aria-hidden />
        </button>
        <span className="min-w-40 px-2 text-center text-white tabular-nums" aria-live="polite">
          {position}
        </span>
        <button type="button" className={btn} onClick={() => go(1)} aria-label="Suivant (→)">
          <ChevronRight className="size-4" aria-hidden />
        </button>
        <span className="mx-1 h-5 w-px bg-white/20" aria-hidden />
        <button type="button" className={btn} onClick={() => setPlaying((p) => !p)} aria-pressed={playing} aria-label={playing ? "Arrêter le diaporama (P)" : "Lancer le diaporama (P)"}>
          {playing ? <Pause className="size-4" aria-hidden /> : <Play className="size-4" aria-hidden />}
          <span>{playing ? "Pause" : "Diaporama"}</span>
        </button>
        <select
          aria-label="Durée par diapositive"
          value={delay}
          onChange={(e) => setDelay(Number(e.target.value))}
          className="rounded-md bg-white/10 px-1.5 py-1 text-white [&>option]:text-black"
        >
          {DELAYS.map((d) => (
            <option key={d} value={d}>
              {d} s
            </option>
          ))}
        </select>
        {bookmarks.length > 0 && (
          <div className="ml-1 flex rounded-md bg-white/10 p-0.5" role="group" aria-label="Dérouler">
            {(["pages", "bookmarks"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={source === v}
                onClick={() => {
                  setSource(v);
                  setBookmarkIndex(-1);
                }}
                className={clsx("flex items-center gap-1 rounded px-2 py-1", source === v ? "bg-white/20 text-white" : "text-white/70 hover:text-white")}
              >
                {v === "pages" ? <Files className="size-3.5" aria-hidden /> : <Bookmark className="size-3.5" aria-hidden />}
                {v === "pages" ? "Pages" : "Signets"}
              </button>
            ))}
          </div>
        )}
        <span className="mx-1 h-5 w-px bg-white/20" aria-hidden />
        <button type="button" className={btn} onClick={onExit} aria-label="Quitter la présentation (Échap)">
          <X className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

/** Bandeau d'une page d'extraction : filtres reçus et retour à la page d'origine. */
export function ExtractionBar({ label, from, dark = false }: { label: string; from: string; dark?: boolean }) {
  return (
    <div
      role="status"
      className={clsx(
        "absolute z-30 flex max-w-[70%] items-center gap-2 rounded-full border py-1 pr-1 pl-3 text-xs shadow-lg",
        // Présentation : en haut (commandes en bas) ; Studio : en bas à gauche (zoom en bas à droite).
        dark ? "top-3 left-1/2 -translate-x-1/2 border-white/15 bg-black/75 text-white backdrop-blur" : "atelier-pop bottom-3 left-3 border-border bg-surface text-fg",
      )}
    >
      <span className="truncate">
        <span className={dark ? "text-white/70" : "text-muted"}>Extraction :</span> {label}
      </span>
      <button
        type="button"
        onClick={() => useStudio.getState().backFromExtraction()}
        className={clsx("flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 font-medium", dark ? "bg-white/15 hover:bg-white/25" : "bg-accent-soft text-accent-ink hover:bg-accent-faint")}
      >
        <CornerUpLeft className="size-3.5" aria-hidden /> Retour{from ? ` à « ${from} »` : ""}
      </button>
    </div>
  );
}
