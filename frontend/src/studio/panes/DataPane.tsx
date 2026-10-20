import clsx from "clsx";
import { Calculator, Pencil, Plus, RefreshCw, Search, SquareFunction } from "lucide-react";
import { useState } from "react";

import { KIND_META, sinceLabel } from "../../features/data/connect/meta";
import { TYPE_META } from "../../features/data/FieldsPanel";
import { refreshDataset } from "../../hooks/useDatasetProfiles";
import type { ColumnProfile } from "../../types/dataset";
import { measureField } from "../../visuals/fields";
import { VISUALS } from "../../visuals/registry";
import { FIELD_MIME, type DraggedField, useStudioData } from "../context";
import { type ModelItemKind, ModelEditor } from "../ModelEditor";
import { useStudio } from "../store";
import { Pane } from "./Pane";

/** Volet Données : choix du jeu, champs et mesures glissables ; un clic ajoute le champ au visuel sélectionné. */
export function DataPane() {
  const { datasets, profiles, activeDatasetId, setActiveDatasetId } = useStudioData();
  const selectedId = useStudio((s) => s.selectedId);
  const report = useStudio((s) => s.report);
  const [search, setSearch] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [editor, setEditor] = useState<{ kind: ModelItemKind; initial?: { name: string; expression: string } } | null>(null);
  const profile = activeDatasetId ? profiles.get(activeDatasetId) : undefined;
  const selected = report?.pages.flatMap((p) => p.visuals).find((v) => v.id === selectedId);
  const used = new Set(selected ? Object.values(selected.roles).flat().map((b) => `${b.agg === "calc" ? "m" : "c"}:${b.field}`) : []);

  const addField = (column: ColumnProfile) => {
    if (!activeDatasetId) return;
    const s = useStudio.getState();
    if (selected && VISUALS[selected.type].roles.length) {
      s.dropField(selected.id, column, activeDatasetId);
      return;
    }
    // Rien de sélectionné : visuel adapté au type du champ (comme Power BI).
    const type = column.measure ? "kpi" : column.type === "number" ? "column" : column.type === "date" ? "line" : "table";
    const id = s.addVisual(type, activeDatasetId);
    s.dropField(id, column, activeDatasetId);
  };

  const match = (name: string) => name.toLowerCase().includes(search.toLowerCase());
  const columns = (profile?.columns ?? []).filter((c) => match(c.name));
  const measures = (profile?.model?.measures ?? []).filter((m) => match(m.name));

  const item = (field: ColumnProfile, edit?: () => void) => {
    const { icon: TypeIcon, label } = TYPE_META[field.type];
    const Icon = field.measure ? Calculator : field.calculated ? SquareFunction : TypeIcon;
    const isUsed = used.has(`${field.measure ? "m" : "c"}:${field.name}`);
    const drag: DraggedField = { datasetId: activeDatasetId ?? "", field: field.name, measure: field.measure };
    const hint = field.measure ? `Mesure calculée = ${field.expression}` : field.calculated ? `Colonne calculée = ${field.expression}` : label;
    return (
      <li key={`${field.measure ? "m" : "c"}-${field.name}`} className="group/field flex items-center">
        <button
          type="button"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(FIELD_MIME, JSON.stringify(drag));
            e.dataTransfer.effectAllowed = "copy";
          }}
          onClick={() => addField(field)}
          title={`${hint} — cliquez ou glissez vers un visuel`}
          className={clsx(
            "flex min-w-0 flex-1 cursor-grab items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-surface-2 active:cursor-grabbing",
            isUsed && "font-semibold",
          )}
        >
          <Icon className="size-3.5 shrink-0 text-accent-ink" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{field.name}</span>
          {isUsed && <span className="size-1.5 rounded-full bg-accent" aria-label="utilisé" />}
        </button>
        {edit && (
          <button
            type="button"
            onClick={edit}
            aria-label={`Modifier ${field.name}`}
            className="rounded p-1 text-muted opacity-0 hover:text-fg focus:opacity-100 group-hover/field:opacity-100"
          >
            <Pencil className="size-3" aria-hidden />
          </button>
        )}
      </li>
    );
  };

  return (
    <Pane title="Données" width="w-56">
      <div className="space-y-2 border-b border-border p-3">
        <label className="sr-only" htmlFor="dataset-select">
          Jeu de données
        </label>
        <select
          id="dataset-select"
          value={activeDatasetId ?? ""}
          onChange={(e) => setActiveDatasetId(e.target.value)}
          className="w-full rounded-md border border-border bg-bg px-2 py-1.5 text-xs"
        >
          {!datasets.length && <option value="">Aucun jeu — importez des données</option>}
          {datasets.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        {profile?.origin && (
          <div className="flex items-center gap-1 text-[11px] text-muted">
            <span
              className="min-w-0 flex-1 truncate"
              title={`${KIND_META[profile.origin.kind].label} · ${profile.origin.connection_name} — actualisé ${sinceLabel(profile.origin.refreshed_at)}`}
            >
              {sinceLabel(profile.origin.refreshed_at)}
            </span>
            <button
              type="button"
              disabled={refreshing}
              onClick={() => {
                setRefreshing(true);
                refreshDataset(profile.id)
                  .then((p) => useStudio.getState().notify(`« ${p.name} » actualisé : ${p.rows.toLocaleString("fr-FR")} lignes.`))
                  .catch((e: unknown) => useStudio.getState().notify(`Actualisation impossible : ${e instanceof Error ? e.message : String(e)}`))
                  .finally(() => setRefreshing(false));
              }}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 font-medium text-accent-ink hover:bg-accent-soft disabled:opacity-60"
              title="Relire la source : tous les visuels se mettent à jour"
            >
              <RefreshCw className={clsx("size-3", refreshing && "animate-spin")} aria-hidden /> Actualiser
            </button>
          </div>
        )}
        <label className="flex items-center gap-1.5 rounded-md border border-border bg-bg px-2 py-1 text-xs">
          <Search className="size-3 text-muted" aria-hidden />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Rechercher un champ" className="min-w-0 flex-1 bg-transparent outline-none" />
        </label>
        {profile && (
          <div className="grid grid-cols-2 gap-1">
            <button
              type="button"
              onClick={() => setEditor({ kind: "measure" })}
              className="flex items-center justify-center gap-1 rounded-md border border-border px-1.5 py-1 text-[11px] text-muted hover:border-accent-ink hover:text-accent-ink"
            >
              <Plus className="size-3" aria-hidden /> Mesure
            </button>
            <button
              type="button"
              onClick={() => setEditor({ kind: "column" })}
              className="flex items-center justify-center gap-1 rounded-md border border-border px-1.5 py-1 text-[11px] text-muted hover:border-accent-ink hover:text-accent-ink"
            >
              <Plus className="size-3" aria-hidden /> Colonne
            </button>
          </div>
        )}
      </div>
      {measures.length > 0 && (
        <>
          <p className="px-3 pt-2 text-[10px] font-semibold uppercase tracking-wide text-muted">Mesures</p>
          <ul className="p-1.5" aria-label="Mesures calculées">
            {measures.map((m) => item(measureField(m), () => setEditor({ kind: "measure", initial: m })))}
          </ul>
        </>
      )}
      {measures.length > 0 && <p className="px-3 pt-1 text-[10px] font-semibold uppercase tracking-wide text-muted">Colonnes</p>}
      <ul className="p-1.5" aria-label="Colonnes">
        {columns.map((c) => item(c, c.calculated ? () => setEditor({ kind: "column", initial: { name: c.name, expression: c.expression ?? "" } }) : undefined))}
      </ul>
      {editor && profile && <ModelEditor profile={profile} kind={editor.kind} initial={editor.initial} onClose={() => setEditor(null)} />}
    </Pane>
  );
}
