/**
 * Image d'une page entière (export PNG, PDF, rapport HTML) : la page est rendue hors écran à sa
 * taille réelle, avec ses visuels tels qu'à l'écran (mêmes composants, mêmes requêtes, thème du
 * rapport), en lecture seule, puis photographiée par html-to-image. Rien ne quitte la machine.
 */

import { getFontEmbedCSS, toPng } from "html-to-image";
import { createRoot } from "react-dom/client";

import { StudioDataContext } from "../studio/context";
import type { Extraction } from "../studio/extraction";
import { DEFAULT_PAGE, GAP } from "../studio/grid";
import { SnapshotContext } from "../studio/snapshot";
import { VisualContainer } from "../studio/VisualContainer";
import { type ReportTheme, themeVars } from "../theme/reportTheme";
import type { DatasetProfile } from "../types/dataset";
import type { Page, Report } from "../types/report";
import type { Selection } from "../visuals/types";
import { waitForIdle } from "./capture";

export interface PageImageRequest {
  page: Page;
  report: Report;
  profiles: Map<string, DatasetProfile>;
  theme: ReportTheme;
  selection: Selection | null;
  extraction?: Extraction | null;
  /** Densité (2 = net à l'impression). */
  pixelRatio?: number;
}

export interface PageImage {
  dataUrl: string;
  /** Taille de la page (px CSS). */
  width: number;
  height: number;
}

/** Taille rendue d'une page : sa taille, allongée si un visuel dépasse le bas. */
export function pageExtent(page: Page): { width: number; height: number } {
  const size = page.size ?? DEFAULT_PAGE;
  const bottom = page.visuals.reduce((m, v) => Math.max(m, v.layout.y + v.layout.h), 0);
  return { width: size.width, height: Math.max(size.height, bottom > size.height ? bottom + GAP : 0) };
}

let fontCss: Promise<string> | null = null;

/** Rend la page hors écran et la photographie (PNG, data URL). Lève une erreur si la capture échoue. */
export async function capturePage(req: PageImageRequest): Promise<PageImage> {
  const { width, height } = pageExtent(req.page);
  const host = document.createElement("div");
  host.className = `${req.theme.mode === "dark" ? "theme-dark" : "theme-light"} bg-canvas text-fg`;
  host.setAttribute("data-theme", req.theme.mode);
  host.setAttribute("aria-hidden", "true");
  host.setAttribute("data-snapshot", ""); // barres de défilement masquées (index.css)
  Object.assign(host.style, { position: "fixed", left: "-100000px", top: "0", width: `${width}px`, height: `${height}px`, pointerEvents: "none" });
  for (const [k, v] of Object.entries(themeVars(req.theme) as Record<string, string>)) {
    if (k.startsWith("--")) host.style.setProperty(k, v);
  }
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    root.render(
      <StudioDataContext.Provider value={{ datasets: [], profiles: req.profiles, activeDatasetId: null, setActiveDatasetId: () => undefined }}>
        <SnapshotContext.Provider value={{ selection: req.selection, extraction: req.extraction ?? null }}>
          <div style={{ position: "relative", width, height, background: "var(--page-bg)", color: "var(--fg)" }}>
            {req.page.visuals.map((v) => (
              <div key={v.id} style={{ position: "absolute", left: v.layout.x, top: v.layout.y, width: v.layout.w, height: v.layout.h }}>
                <VisualContainer visual={v} page={req.page} report={req.report} />
              </div>
            ))}
          </div>
        </SnapshotContext.Provider>
      </StudioDataContext.Provider>,
    );
    await waitForIdle(host, 400, 20_000);
    fontCss ??= getFontEmbedCSS(host).catch(() => "");
    const dataUrl = await toPng(host, {
      pixelRatio: req.pixelRatio ?? 2,
      fontEmbedCSS: await fontCss,
      width,
      height,
      style: { left: "0", position: "static" },
    });
    return { dataUrl, width, height };
  } finally {
    root.unmount();
    host.remove();
  }
}

/** Data URL → octets. */
export function dataUrlBytes(dataUrl: string): Uint8Array<ArrayBuffer> {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bin = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
