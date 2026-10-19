/**
 * Capture d'un visuel en image (PNG) : le composant est rendu hors écran, à la taille qu'il a
 * dans la page, avec les couleurs du thème, puis photographié par html-to-image.
 * Tout reste local : les polices sont celles déjà servies par l'application.
 */

import { getFontEmbedCSS, toPng } from "html-to-image";
import { createRoot } from "react-dom/client";

import type { DatasetProfile } from "../types/dataset";
import type { Filter } from "../types/query";
import type { Page, Report, Visual } from "../types/report";
import { type ReportTheme, type VisualStyle, themeVars, visualCss } from "../theme/reportTheme";
import type { VisualDef } from "../visuals/types";
import type { QueryResult } from "../visuals/useQueryResult";

export interface CaptureRequest {
  visual: Visual;
  def: VisualDef;
  dataset: DatasetProfile | undefined;
  result: QueryResult | null;
  filters: Filter[];
  page: Page;
  report: Report;
  theme: ReportTheme;
  /** Taille du corps du visuel à l'écran (px). */
  width: number;
  height: number;
  /** Densité de l'image (2 = net sur un écran haute résolution et en impression). */
  pixelRatio?: number;
}

let fontCss: Promise<string> | null = null;

const noop = () => undefined;

/** Attend que le rendu soit stable : plus de chargement en cours et aucune mutation pendant `quiet` ms. */
export function waitForIdle(node: HTMLElement, quiet = 250, timeout = 10_000): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const busy = () => node.querySelector('.animate-spin, [aria-label="Chargement"]') !== null;
    const done = () => {
      observer.disconnect();
      resolve();
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (busy() && Date.now() - started < timeout) arm();
        else done();
      }, quiet);
    };
    const observer = new MutationObserver(() => (Date.now() - started > timeout ? done() : arm()));
    observer.observe(node, { subtree: true, childList: true, attributes: true, characterData: true });
    arm();
  });
}

/** Rend le corps du visuel hors écran et retourne une image PNG (data URL), ou null en cas d'échec. */
export async function captureVisual(req: CaptureRequest): Promise<string | null> {
  const style = req.visual.options.style as VisualStyle | undefined;
  const host = document.createElement("div");
  host.className = req.theme.mode === "dark" ? "theme-dark" : "theme-light";
  host.setAttribute("data-theme", req.theme.mode); // fondation du design system (docs/SUITE.md §1.5)
  host.setAttribute("aria-hidden", "true");
  const vars = { ...themeVars(req.theme), ...visualCss(style, req.theme.page) } as Record<string, string>;
  Object.assign(host.style, {
    position: "fixed",
    left: "-100000px",
    top: "0",
    width: `${Math.round(req.width)}px`,
    height: `${Math.round(req.height)}px`,
    pointerEvents: "none",
    color: "var(--fg)",
    // Le corps est photographié sans fond : c'est le cadre de la diapositive qui porte la couleur.
    background: "transparent",
    border: "none",
    padding: "0",
    boxShadow: "none",
    display: "flex",
    flexDirection: "column",
  });
  for (const [k, v] of Object.entries(vars)) {
    if (k.startsWith("--")) host.style.setProperty(k, v);
  }
  document.body.appendChild(host);
  const root = createRoot(host);
  const Component = req.def.component;
  try {
    root.render(
      <div style={{ width: "100%", height: "100%", minHeight: 0, flex: 1 }}>
        <Component
          visual={req.visual}
          def={req.def}
          dataset={req.dataset}
          result={req.result}
          filters={req.filters}
          selection={null}
          onSelect={noop}
          setOptions={noop}
          actions={{
            pages: req.report.pages,
            pageId: req.page.id,
            reportName: req.report.name,
            goToPage: noop,
            resetFilters: noop,
            activeFilters: req.filters,
          }}
          editing={false}
        />
      </div>,
    );
    await waitForIdle(host);
    fontCss ??= getFontEmbedCSS(host).catch(() => "");
    return await toPng(host, {
      pixelRatio: req.pixelRatio ?? 2,
      fontEmbedCSS: await fontCss,
      width: Math.round(req.width),
      height: Math.round(req.height),
      // Le style « left: -100000px » ne doit pas être recopié dans l'image.
      style: { left: "0", position: "static" },
    });
  } catch {
    return null;
  } finally {
    root.unmount();
    host.remove();
  }
}
