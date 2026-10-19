import clsx from "clsx";
import { Search } from "lucide-react";
import { useState } from "react";

import { TYPE_META } from "../../features/data/FieldsPanel";
import type { ColumnProfile } from "../../types/dataset";
import { VISUALS } from "../../visuals/registry";
import { FIELD_MIME, useStudioData } from "../context";
import { useStudio } from "../store";
import { Pane } from "./Pane";

/** Volet Données : choix du jeu, champs glissables ; un clic ajoute le champ au visuel sélectionné. */
export function DataPane() {
  const { datasets, profiles, activeDatasetId, setActiveDatasetId } = useStudioData();
  const selectedId = useStudio((s) => s.selectedId);
  const report = useStudio((s) => s.report);
  const [search, setSearch] = useState("");
  const profile = activeDatasetId ? profiles.get(activeDatasetId) : undefined;
  const selected = report?.pages.flatMap((p) => p.visuals).find((v) => v.id === selectedId);
  const used = new Set(selected ? Object.values(selected.roles).flat().map((b) => b.field) : []);

  const addField = (column: ColumnProfile) => {
    if (!activeDatasetId) return;
    const s = useStudio.getState();
    if (selected && VISUALS[selected.type].roles.length) {
      s.dropField(selected.id, column, activeDatasetId);
      return;
    }
    // Rien de sélectionné : visuel adapté au type du champ (comme Power BI).
    const type = column.type === "number" ? "column" : column.type === "date" ? "line" : "table";
    const id = s.addVisual(type, activeDatasetId);
    s.dropField(id, column, activeDatasetId);
  };

  const columns = (profile?.columns ?? []).filter((c) => c.name.toLowerCase().includes(search.toLowerCase()));

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
        <label className="flex items-center gap-1.5 rounded-md border border-border bg-bg px-2 py-1 text-xs">
          <Search className="size-3 text-muted" aria-hidden />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Rechercher un champ" className="min-w-0 flex-1 bg-transparent outline-none" />
        </label>
      </div>
      <ul className="p-1.5">
        {columns.map((c) => {
          const { icon: Icon, label } = TYPE_META[c.type];
          return (
            <li key={c.name}>
              <button
                type="button"
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(FIELD_MIME, JSON.stringify({ datasetId: activeDatasetId, field: c.name }));
                  e.dataTransfer.effectAllowed = "copy";
                }}
                onClick={() => addField(c)}
                title={`${label} — cliquez ou glissez vers un visuel`}
                className={clsx(
                  "flex w-full cursor-grab items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-surface-2 active:cursor-grabbing",
                  used.has(c.name) && "font-semibold",
                )}
              >
                <Icon className="size-3.5 shrink-0 text-accent" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                {used.has(c.name) && <span className="size-1.5 rounded-full bg-accent" aria-label="utilisé" />}
              </button>
            </li>
          );
        })}
      </ul>
    </Pane>
  );
}
