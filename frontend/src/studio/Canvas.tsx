import ReactGridLayout, { useContainerWidth, verticalCompactor } from "react-grid-layout";

import type { Page, Report } from "../types/report";
import { useStudio } from "./store";
import { VisualContainer } from "./VisualContainer";

export const GRID_COLS = 24;
export const ROW_HEIGHT = 16;

/** Canvas de la page : grille de 24 colonnes, déplacement par la poignée, redimensionnement par le coin. */
export function Canvas({ page, report }: { page: Page; report: Report }) {
  const { width, containerRef, mounted } = useContainerWidth();
  const mode = useStudio((s) => s.mode);
  const editing = mode === "edit";
  const layout = page.visuals.map((v) => ({ i: v.id, ...v.layout, minW: 2, minH: 3 }));

  return (
    <div
      ref={containerRef}
      className="min-h-full rounded-xl p-1"
      style={{ background: "var(--page-bg)" }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) useStudio.getState().select(null);
      }}
    >
      {page.visuals.length === 0 && (
        <div className="flex h-72 flex-col items-center justify-center gap-1 text-center text-sm text-muted">
          <p className="font-medium text-fg">Page vide</p>
          <p className="max-w-sm text-xs">
            Choisissez un visuel dans le volet Visualisations, ou cliquez sur un champ du volet Données pour créer un visuel automatiquement.
          </p>
        </div>
      )}
      {mounted && width > 0 && (
        <ReactGridLayout
          width={width - 8}
          layout={layout}
          gridConfig={{ cols: GRID_COLS, rowHeight: ROW_HEIGHT, margin: [8, 8], containerPadding: [4, 4] }}
          dragConfig={{ enabled: editing, handle: ".visual-handle", cancel: "button" }}
          resizeConfig={{ enabled: editing, handles: ["se", "e", "s"] }}
          compactor={verticalCompactor}
          onDragStop={(l) => useStudio.getState().setLayouts(l)}
          onResizeStop={(l) => useStudio.getState().setLayouts(l)}
        >
          {page.visuals.map((v) => (
            <div key={v.id}>
              <VisualContainer visual={v} page={page} report={report} />
            </div>
          ))}
        </ReactGridLayout>
      )}
    </div>
  );
}
