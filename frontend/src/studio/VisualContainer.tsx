import clsx from "clsx";
import { Copy, GripHorizontal, Loader2, Trash2 } from "lucide-react";
import { type DragEvent, memo, useMemo, useState } from "react";

import type { Page, Report, Visual } from "../types/report";
import { VisualMessage, isReady } from "../visuals/common";
import { type VisualStyle, readTheme, titleCss, visualCss } from "../theme/reportTheme";
import { VISUALS } from "../visuals/registry";
import { defaultTitle } from "../visuals/title";
import type { VisualActions } from "../visuals/types";
import { useQueryResult } from "../visuals/useQueryResult";
import { FIELD_MIME, type DraggedField, useStudioData } from "./context";
import { pageActiveFilters, visualFilters } from "./filters";
import { useStudio } from "./store";

interface Props {
  visual: Visual;
  page: Page;
  report: Report;
}

/** Cadre d'un visuel sur le canvas : titre, requête, états vides / erreurs, sélection, dépôt de champs. */
export const VisualContainer = memo(function VisualContainer({ visual, page, report }: Props) {
  const def = VISUALS[visual.type];
  const { profiles } = useStudioData();
  const mode = useStudio((s) => s.mode);
  const selectedId = useStudio((s) => s.selectedId);
  const selection = useStudio((s) => s.selection);
  const studio = useStudio.getState;
  const [dropping, setDropping] = useState(false);
  const editing = mode === "edit";
  const selected = editing && selectedId === visual.id;
  const dataset = visual.dataset_id ? profiles.get(visual.dataset_id) : undefined;

  const filters = useMemo(
    () => visualFilters(page, visual, selection, (id) => (id ? new Set(profiles.get(id)?.columns.map((c) => c.name)) : undefined)),
    [page, visual, selection, profiles],
  );
  const request = def.query ? def.query(visual, filters) : null;
  const { result, loading, error } = useQueryResult(request);

  const actions: VisualActions = {
    pages: report.pages,
    pageId: page.id,
    reportName: report.name,
    goToPage: (id) => studio().setPage(id),
    resetFilters: () => studio().resetFilters(),
    activeFilters: pageActiveFilters(page, selection),
  };

  const onDrop = (e: DragEvent) => {
    setDropping(false);
    const raw = e.dataTransfer.getData(FIELD_MIME);
    if (!raw || !editing) return;
    e.preventDefault();
    const dragged = JSON.parse(raw) as DraggedField;
    const column = profiles.get(dragged.datasetId)?.columns.find((c) => c.name === dragged.field);
    if (column) studio().dropField(visual.id, column, dragged.datasetId);
    studio().select(visual.id);
  };

  const Component = def.component;
  let body: React.ReactNode;
  if (def.query && !isReady(visual, def)) {
    const missing = def.roles.filter((r) => r.required && !(visual.roles[r.id]?.length)).map((r) => r.label);
    body = (
      <VisualMessage>
        <span className="flex flex-col items-center gap-2">
          <def.icon className="size-8 opacity-40" aria-hidden />
          {editing ? `Glissez des champs ici — requis : ${missing.join(", ")}` : "Visuel non configuré"}
        </span>
      </VisualMessage>
    );
  } else if (error) {
    body = <VisualMessage tone="error">{error}</VisualMessage>;
  } else if (def.query && !result) {
    body = (
      <VisualMessage>
        <Loader2 className="size-4 animate-spin" aria-label="Chargement" />
      </VisualMessage>
    );
  } else {
    body = (
      <Component
        visual={visual}
        def={def}
        dataset={dataset}
        result={result}
        filters={filters}
        selection={selection}
        onSelect={(s) => studio().setSelection(s)}
        setOptions={(patch) => studio().setOptions(visual.id, patch, false)}
        actions={actions}
        editing={editing}
      />
    );
  }

  // Boutons et textes : pas de cadre ni de titre par défaut (comme dans Power BI).
  const bare = visual.type === "button" || visual.type === "text";
  const style = visual.options.style as VisualStyle | undefined;
  const showTitle = visual.title !== "" && !bare && style?.showTitle !== false;
  const frame: React.CSSProperties = bare
    ? { background: "transparent", border: "1px solid transparent", borderRadius: "var(--visual-radius)", padding: 6 }
    : {
        background: "var(--visual-bg)",
        border: "var(--visual-border)",
        borderRadius: "var(--visual-radius)",
        boxShadow: "var(--visual-shadow)",
        padding: 12,
      };
  const pageColor = readTheme(report.theme)?.page ?? null;

  return (
    <section
      aria-label={visual.title || defaultTitle(visual)}
      // Sélection au clic (pas au mousedown) : un re-rendu entre mousedown et mouseup ferait perdre le clic du graphique.
      onClick={() => editing && studio().select(visual.id)}
      onDragOver={(e) => {
        if (editing && e.dataTransfer.types.includes(FIELD_MIME)) {
          e.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={onDrop}
      style={{ ...frame, ...visualCss(style, pageColor), color: "var(--fg)" }}
      className={clsx(
        "group/visual relative flex h-full flex-col outline-offset-2",
        // Sélection et dépôt : contour (outline) pour ne pas toucher à la bordure choisie par l'utilisateur.
        selected || dropping ? "outline-2 outline-accent" : bare && editing ? "hover:outline-1 hover:outline-dashed hover:outline-border" : "",
      )}
    >
      {editing && (
        <div
          className={clsx(
            "visual-handle absolute inset-x-0 top-0 z-20 flex h-6 cursor-move items-center justify-between rounded-t-lg px-1.5 text-muted",
            selected ? "opacity-100" : "opacity-0 group-hover/visual:opacity-100",
          )}
        >
          <GripHorizontal className="size-3.5" aria-hidden />
          <span className="flex gap-0.5">
            <button
              type="button"
              aria-label="Dupliquer le visuel"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => studio().duplicateVisual(visual.id)}
              className="rounded bg-surface p-1 hover:text-fg"
            >
              <Copy className="size-3" aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Supprimer le visuel"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => studio().removeVisual(visual.id)}
              className="rounded bg-surface p-1 hover:text-negative"
            >
              <Trash2 className="size-3" aria-hidden />
            </button>
          </span>
        </div>
      )}
      {showTitle && (
        <header className="mb-1.5 flex min-h-5 items-center gap-2">
          <h3 className="min-w-0 flex-1 truncate text-[13px] font-medium" style={titleCss(style)}>
            {visual.title ?? defaultTitle(visual)}
          </h3>
          {loading && result && <Loader2 className="size-3 animate-spin text-muted" aria-label="Actualisation" />}
          {result?.truncated && <span className="text-[10px] text-muted" title="Résultat limité : utilisez un Top N ou des filtres">tronqué</span>}
        </header>
      )}
      <div className="min-h-0 flex-1">{body}</div>
    </section>
  );
});
