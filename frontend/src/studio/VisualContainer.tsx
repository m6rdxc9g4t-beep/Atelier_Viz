import clsx from "clsx";
import { ArrowDown, ArrowUp, BellPlus, BringToFront, ChevronsDown, Copy, GripHorizontal, Loader2, SendToBack, Trash2 } from "lucide-react";
import { type DragEvent, memo, useMemo, useState } from "react";

import { AlertEditor } from "../features/automation/AlertEditor";
import { alertFromVisual } from "../features/automation/alerts";
import type { Page, Report, Visual } from "../types/report";
import { first } from "../visuals/common";
import { bindingKey } from "../visuals/fields";
import { VisualMessage, isReady } from "../visuals/common";
import { type VisualStyle, readTheme, titleCss, visualCss } from "../theme/reportTheme";
import { canDrill, drillCrumbs, drillDown, drillLevels, drillState, drillUp, drillView, nextLevel } from "../visuals/drill";
import { findField } from "../visuals/fields";
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
  const { profiles, datasets } = useStudioData();
  const [alerting, setAlerting] = useState(false);
  const mode = useStudio((s) => s.mode);
  const selectedId = useStudio((s) => s.selectedId);
  const selection = useStudio((s) => s.selection);
  const studio = useStudio.getState;
  const [dropping, setDropping] = useState(false);
  // Mode exploration (Power BI) : un clic sur un élément descend d'un niveau au lieu de filtrer les autres visuels.
  const [drillMode, setDrillMode] = useState(false);
  const editing = mode === "edit";
  const selected = editing && selectedId === visual.id;
  const dataset = visual.dataset_id ? profiles.get(visual.dataset_id) : undefined;

  // Visuel tel qu'affiché au niveau d'exploration courant (un seul champ d'Axe, chemin en filtres).
  const view = useMemo(() => drillView(visual), [visual]);
  const drillable = canDrill(visual);
  const filters = useMemo(
    () => visualFilters(page, view, selection, (id) => profiles.get(id)),
    [page, view, selection, profiles],
  );
  const request = def.query ? def.query(view, filters) : null;
  const setDrill = (state: ReturnType<typeof drillUp>) => {
    if (!state) return;
    studio().setOptions(visual.id, { drill: state }, false);
    if (studio().selection?.visualId === visual.id) studio().setSelection(null);
  };
  const { result, loading, error } = useQueryResult(request);

  const actions: VisualActions = {
    pages: report.pages,
    pageId: page.id,
    reportName: report.name,
    goToPage: (id) => studio().setPage(id),
    resetFilters: () => studio().resetFilters(),
    applyBookmark: (id) => studio().applyBookmark(id),
    activeFilters: pageActiveFilters(page, selection),
  };

  const onDrop = (e: DragEvent) => {
    setDropping(false);
    const raw = e.dataTransfer.getData(FIELD_MIME);
    if (!raw || !editing) return;
    e.preventDefault();
    const dragged = JSON.parse(raw) as DraggedField;
    const column = findField(profiles.get(dragged.datasetId), dragged.field, dragged.measure);
    if (column) studio().dropField(visual.id, column, dragged.datasetId);
    studio().select(visual.id);
  };

  const Component = def.component;
  let body: React.ReactNode;
  if (def.query && !isReady(view, def)) {
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
        visual={view}
        def={def}
        dataset={dataset}
        result={result}
        filters={filters}
        selection={selection}
        onSelect={(s) => {
          // En mode exploration, le clic sur un élément descend d'un niveau.
          const value = s?.filters[0]?.values[0];
          if (drillMode && s && s.visualId === visual.id && value !== undefined) {
            const next = drillDown(visual, value);
            if (next) return setDrill(next);
          }
          studio().setSelection(s);
        }}
        setOptions={(patch) => studio().setOptions(visual.id, patch, false)}
        actions={actions}
        editing={editing}
      />
    );
  }

  // Alerte depuis un KPI ou une jauge : même mesure, mêmes filtres, seuil = cible ou valeur affichée.
  const valueB = first(view, "values");
  const targetB = first(view, "target");
  const row = result?.rows[0];
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const alertDraft = editing
    ? alertFromVisual(view, filters, {
        value: valueB && row ? num(row[bindingKey(valueB)]) : null,
        target: targetB && row ? num(row[bindingKey(targetB)]) : null,
      })
    : null;

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
      data-visual-id={visual.id}
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
            "visual-handle absolute inset-x-0 top-0 z-20 flex h-6 cursor-move touch-none items-center justify-between rounded-t-lg px-1.5 text-muted",
            selected ? "opacity-100" : "opacity-0 group-hover/visual:opacity-100",
          )}
        >
          <GripHorizontal className="size-3.5" aria-hidden />
          <span className="flex gap-0.5">
            {alertDraft && (
              <button
                type="button"
                aria-label="Créer une alerte sur cette valeur"
                title="Créer une alerte sur cette valeur (seuil, notification, webhook)"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => setAlerting(true)}
                className="rounded bg-surface p-1 hover:text-fg"
              >
                <BellPlus className="size-3" aria-hidden />
              </button>
            )}
            <button
              type="button"
              aria-label="Premier plan"
              title="Premier plan"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => studio().reorder(visual.id, "front")}
              className="rounded bg-surface p-1 hover:text-fg"
            >
              <BringToFront className="size-3" aria-hidden />
            </button>
            <button
              type="button"
              aria-label="Arrière-plan"
              title="Arrière-plan"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => studio().reorder(visual.id, "back")}
              className="rounded bg-surface p-1 hover:text-fg"
            >
              <SendToBack className="size-3" aria-hidden />
            </button>
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
      {drillable && <DrillBar visual={visual} dataset={dataset} drillMode={drillMode} onToggle={() => setDrillMode((m) => !m)} onChange={setDrill} />}
      <div className="min-h-0 flex-1">{body}</div>
      {alerting && alertDraft && (
        <AlertEditor
          initial={alertDraft}
          datasets={datasets}
          onClose={() => setAlerting(false)}
          onSaved={(a) => {
            setAlerting(false);
            studio().notify(`Alerte « ${a.name} » créée : retrouvez-la dans Automatisation.`);
          }}
        />
      )}
    </section>
  );
});

/** Barre d'exploration : remonter, mode exploration, niveau suivant, fil d'Ariane. */
function DrillBar({
  visual,
  dataset,
  drillMode,
  onToggle,
  onChange,
}: {
  visual: Visual;
  dataset: Parameters<typeof drillCrumbs>[1];
  drillMode: boolean;
  onToggle: () => void;
  onChange: (state: ReturnType<typeof drillUp>) => void;
}) {
  const { level } = drillState(visual);
  const last = drillLevels(visual).length - 1;
  const crumbs = drillCrumbs(visual, dataset);
  const btn = "rounded p-0.5 text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent";
  return (
    <div className="mb-1 flex min-h-5 items-center gap-0.5 text-[11px]" role="toolbar" aria-label="Exploration">
      <button type="button" className={btn} disabled={level === 0} onClick={() => onChange(drillUp(visual))} aria-label="Monter d'un niveau" title="Monter d'un niveau">
        <ArrowUp className="size-3.5" aria-hidden />
      </button>
      <button
        type="button"
        className={clsx(btn, drillMode && "bg-accent/15 text-accent hover:text-accent")}
        disabled={level === last}
        aria-pressed={drillMode}
        onClick={onToggle}
        aria-label="Mode exploration : cliquer un élément pour descendre"
        title="Mode exploration : cliquez un élément pour descendre d'un niveau"
      >
        <ArrowDown className="size-3.5" aria-hidden />
      </button>
      <button type="button" className={btn} disabled={level === last} onClick={() => onChange(nextLevel(visual))} aria-label="Niveau suivant (tous les éléments)" title="Niveau suivant (tous les éléments)">
        <ChevronsDown className="size-3.5" aria-hidden />
      </button>
      <span className="ml-1 min-w-0 truncate text-muted" title={crumbs.join(" › ")}>
        {crumbs.map((c, i) => (
          <span key={`${c}-${i}`}>
            {i > 0 && <span aria-hidden> › </span>}
            <span className={i === crumbs.length - 1 ? "font-medium text-fg" : undefined}>{c}</span>
          </span>
        ))}
      </span>
    </div>
  );
}
