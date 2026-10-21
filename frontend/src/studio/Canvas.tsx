import clsx from "clsx";
import { Maximize2, Minus, Plus } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { Layout, Page, Report } from "../types/report";
import { fitScale, fitWidthScale } from "./extraction";
import { DEFAULT_PAGE, GAP } from "./grid";
import { type Guides, RESIZE_DIRS, type ResizeDir, moveRect, resizeCursor, resizeRect } from "./snap";
import { useStudio } from "./store";
import { VisualContainer } from "./VisualContainer";

/** Distance d'accroche aux repères, en pixels d'écran. */
const SNAP_SCREEN_PX = 6;
const ZOOMS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];
const PADDING = 24;

interface Drag {
  id: string;
  dir: ResizeDir | null; // null = déplacement
  startX: number;
  startY: number;
  orig: Layout;
  rect: Layout;
  guides: Guides;
  moved: boolean;
}

/**
 * Canvas de la page en placement libre (au pixel près, comme Power BI) : la page a une taille fixe
 * en pixels, chaque visuel une position absolue. Déplacement par la poignée du haut, redimensionnement
 * par 8 poignées, repères d'alignement sur les autres visuels et la page (Alt : sans accroche),
 * flèches du clavier pour ajuster au pixel (géré dans StudioPage).
 *
 * Le zoom met la page à l'échelle d'un bloc (`transform: scale`), comme Power BI : Recharts corrige
 * ses coordonnées de souris pour une échelle (`getRelativeCoordinate`), les cartes via `localPoint`.
 */
export function Canvas({ page, report, fitPage = false }: { page: Page; report: Report; /** Présentation : page entière à l'écran, sans zoom. */ fitPage?: boolean }) {
  const editing = useStudio((s) => s.mode) === "edit";
  const selectedId = useStudio((s) => s.selectedId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);
  const [availableH, setAvailableH] = useState(0);
  const [zoomChoice, setZoomChoice] = useState<number | "fit">("fit");
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;

  const size = page.size ?? DEFAULT_PAGE;
  const fit = fitPage
    ? fitScale(size, { width: available, height: availableH }, PADDING)
    : fitWidthScale(size.width, available, PADDING);
  const zoom = zoomChoice === "fit" || fitPage ? fit : zoomChoice;

  // Largeur disponible (ajustement à la largeur, comme « Ajuster à la largeur » de Power BI).
  // La gouttière de la barre de défilement est toujours réservée (`scrollbar-gutter: stable`) : sous Windows,
  // la barre prend de la place, et son apparition changeait la largeur, donc le zoom, qui la faisait
  // disparaître… (la page tremblait). Sous macOS, les barres flottent au-dessus du contenu.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      // Mêmes valeurs (au pixel près) : aucun nouveau rendu, donc aucune boucle de mesure.
      setAvailable((cur) => (Math.abs(cur - el.clientWidth) < 1 ? cur : el.clientWidth));
      setAvailableH((cur) => (Math.abs(cur - el.clientHeight) < 1 ? cur : el.clientHeight));
    };
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  // Ctrl + molette : zoom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoomChoice((cur) => {
        const z = cur === "fit" ? fit : cur;
        return Math.min(2, Math.max(0.25, Math.round((z * (e.deltaY < 0 ? 1.1 : 1 / 1.1)) * 100) / 100));
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [fit]);

  const start = (e: ReactPointerEvent, id: string, dir: ResizeDir | null) => {
    const v = page.visuals.find((x) => x.id === id);
    if (!v || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    useStudio.getState().select(id);
    const d: Drag = { id, dir, startX: e.clientX, startY: e.clientY, orig: v.layout, rect: v.layout, guides: { x: [], y: [] }, moved: false };
    setDrag(d);

    const others = page.visuals.filter((x) => x.id !== id).map((x) => x.layout);
    const onMove = (ev: PointerEvent) => {
      const cur = dragRef.current;
      if (!cur) return;
      const dx = (ev.clientX - cur.startX) / zoom;
      const dy = (ev.clientY - cur.startY) / zoom;
      // Petit seuil avant de commencer, pour qu'un simple clic ne déplace rien.
      if (!cur.moved && Math.hypot(ev.clientX - cur.startX, ev.clientY - cur.startY) < 3) return;
      const threshold = SNAP_SCREEN_PX / zoom;
      const snap = !ev.altKey;
      const res = cur.dir
        ? resizeRect(cur.orig, cur.dir, dx, dy, others, size, threshold, snap, ev.shiftKey)
        : moveRect(cur.orig, dx, dy, others, size, threshold, snap);
      setDrag({ ...cur, rect: res.rect, guides: res.guides, moved: true });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      const cur = dragRef.current;
      if (cur?.moved) useStudio.getState().setLayout(cur.id, cur.rect);
      setDrag(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const layoutOf = (id: string, l: Layout) => (drag?.id === id ? drag.rect : l);
  const bottom = page.visuals.reduce((m, v) => Math.max(m, layoutOf(v.id, v.layout).y + layoutOf(v.id, v.layout).h), 0);
  // La page s'allonge pendant qu'on tire un visuel vers le bas.
  const height = Math.max(size.height, drag ? bottom + GAP : 0);
  const selected = editing ? page.visuals.find((v) => v.id === selectedId) : undefined;
  const selRect = selected ? layoutOf(selected.id, selected.layout) : null;
  const px = (n: number) => n * zoom;

  return (
    <>
      <div
        ref={scrollRef}
        className="absolute inset-0 overflow-auto [scrollbar-gutter:stable]"
        style={{ padding: PADDING, paddingTop: fitPage ? Math.max(PADDING, (availableH - px(size.height)) / 2) : PADDING }}
      >
        <div
          role="presentation"
          data-page-frame
          className={clsx("relative mx-auto shadow-sm", drag && "select-none")}
          style={{
            width: px(size.width),
            height: px(height),
            background: "var(--page-bg)",
            outline: "1px solid color-mix(in oklab, var(--fg) 8%, transparent)",
            cursor: drag ? (drag.dir ? resizeCursor(drag.dir) : "move") : undefined,
          }}
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).hasAttribute("data-page-surface")) useStudio.getState().select(null);
          }}
        >
          {/* Page à sa taille réelle (px), mise à l'échelle d'un bloc : textes et graphiques suivent le zoom. */}
          <div
            data-page-surface
            className="absolute top-0 left-0 origin-top-left"
            style={{ width: size.width, height, transform: zoom === 1 ? undefined : `scale(${zoom})` }}
          >
            {page.visuals.length === 0 && (
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1 text-center text-sm text-muted">
                <p className="font-medium text-fg">Page vide</p>
                <p className="max-w-sm text-xs">
                  Choisissez un visuel dans le volet Visualisations, ou cliquez sur un champ du volet Données pour créer un visuel automatiquement.
                </p>
              </div>
            )}

            {page.visuals.map((v) => {
              const l = layoutOf(v.id, v.layout);
              return (
                <div
                  key={v.id}
                  data-visual-frame={v.id}
                  className="absolute"
                  style={{ left: l.x, top: l.y, width: l.w, height: l.h }}
                  onPointerDown={(e) => {
                    if (!editing) return;
                    const t = e.target as HTMLElement;
                    // Déplacement par la poignée (pas par ses boutons).
                    if (t.closest(".visual-handle") && !t.closest("button")) start(e, v.id, null);
                  }}
                >
                  <VisualContainer visual={v} page={page} report={report} />
                </div>
              );
            })}
          </div>

          {/* Calque d'édition (hors mise à l'échelle : poignées toujours à la même taille) : repères, poignées et cotes du visuel sélectionné, au-dessus de tout. */}
          {drag?.guides.x.map((x) => (
            <div key={`gx${x}`} aria-hidden className="pointer-events-none absolute top-0 bottom-0 z-40 w-px bg-[#e5398b]" style={{ left: px(x) }} />
          ))}
          {drag?.guides.y.map((y) => (
            <div key={`gy${y}`} aria-hidden className="pointer-events-none absolute right-0 left-0 z-40 h-px bg-[#e5398b]" style={{ top: px(y) }} />
          ))}
          {selected && selRect && (
            <div
              aria-hidden={!editing}
              className="pointer-events-none absolute z-30"
              style={{ left: px(selRect.x), top: px(selRect.y), width: px(selRect.w), height: px(selRect.h) }}
            >
              {RESIZE_DIRS.map((dir) => (
                <span
                  key={dir}
                  role="presentation"
                  data-resize={dir}
                  title="Redimensionner (Maj : garder les proportions, Alt : sans repères)"
                  onPointerDown={(e) => start(e, selected.id, dir)}
                  className="pointer-events-auto absolute size-2.5 rounded-[2px] border border-accent bg-surface shadow-sm"
                  style={{ ...handlePos(dir), cursor: resizeCursor(dir) }}
                />
              ))}
              {drag?.moved && (
                <span className="absolute -top-6 left-0 rounded bg-fg px-1.5 py-0.5 font-mono text-[10px] whitespace-nowrap text-bg tabular-nums">
                  {drag.dir ? `${selRect.w} × ${selRect.h}` : `x ${selRect.x} · y ${selRect.y}`}
                </span>
              )}
            </div>
          )}
        </div>
      </div>
      {!fitPage && <ZoomControl zoom={zoom} isFit={zoomChoice === "fit"} onChange={setZoomChoice} size={size} />}
    </>
  );
}

/** Position d'une poignée sur le cadre du visuel. */
function handlePos(dir: ResizeDir): React.CSSProperties {
  const s: React.CSSProperties = {};
  const off = -5;
  if (dir.includes("n")) s.top = off;
  else if (dir.includes("s")) s.bottom = off;
  else s.top = "calc(50% - 5px)";
  if (dir.includes("w")) s.left = off;
  else if (dir.includes("e")) s.right = off;
  else s.left = "calc(50% - 5px)";
  return s;
}

/** Zoom de la page : ajuster à la largeur, paliers, et taille de la page pour repère. */
function ZoomControl({
  zoom,
  isFit,
  onChange,
  size,
}: {
  zoom: number;
  isFit: boolean;
  onChange: (z: number | "fit") => void;
  size: { width: number; height: number };
}) {
  const step = (dir: 1 | -1) => {
    const next = dir > 0 ? ZOOMS.find((z) => z > zoom + 0.001) : [...ZOOMS].reverse().find((z) => z < zoom - 0.001);
    if (next) onChange(next);
  };
  const btn = "rounded p-1 text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-30";
  return (
    <div className="absolute right-3 bottom-3 z-20 flex items-center gap-0.5 rounded-md border border-border bg-surface/95 p-0.5 text-xs shadow-sm backdrop-blur" role="group" aria-label="Zoom">
      <span className="px-1.5 text-[11px] text-muted tabular-nums" title="Taille de la page (px)">
        {size.width} × {size.height}
      </span>
      <button type="button" className={btn} onClick={() => step(-1)} disabled={zoom <= (ZOOMS[0] ?? 0.25) + 0.001} aria-label="Zoom arrière">
        <Minus className="size-3.5" aria-hidden />
      </button>
      <button type="button" className="min-w-11 rounded px-1 py-0.5 tabular-nums hover:bg-surface-2" onClick={() => onChange(1)} title="Taille réelle (100 %)">
        {Math.round(zoom * 100)} %
      </button>
      <button type="button" className={btn} onClick={() => step(1)} disabled={zoom >= (ZOOMS[ZOOMS.length - 1] ?? 2) - 0.001} aria-label="Zoom avant">
        <Plus className="size-3.5" aria-hidden />
      </button>
      <button type="button" className={clsx(btn, isFit && "text-accent")} onClick={() => onChange("fit")} aria-pressed={isFit} aria-label="Ajuster à la largeur" title="Ajuster à la largeur">
        <Maximize2 className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}
