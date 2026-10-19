import clsx from "clsx";
import { X } from "lucide-react";
import { useState } from "react";

import type { Agg, DateBin } from "../../types/query";
import type { FieldBinding, Visual, VisualType } from "../../types/report";
import { AGG_LABELS, BIN_LABELS, aggsFor, bindingLabel } from "../../visuals/fields";
import { VISUALS, VISUAL_GROUPS } from "../../visuals/registry";
import type { OptionDef, RoleDef } from "../../visuals/types";
import { FIELD_MIME, type DraggedField, useStudioData } from "../context";
import { useStudio } from "../store";
import { Pane, Section } from "./Pane";
import { VisualStyleSection } from "./VisualStyleSection";

/** Volet Visualisations : galerie (ajouter / changer de type) + onglets Champs et Format. */
export function VisualizationsPane() {
  const report = useStudio((s) => s.report);
  const selectedId = useStudio((s) => s.selectedId);
  const { activeDatasetId } = useStudioData();
  const [tab, setTab] = useState<"build" | "format">("build");
  const visual = report?.pages.flatMap((p) => p.visuals).find((v) => v.id === selectedId);

  const pick = (type: VisualType) => {
    const s = useStudio.getState();
    if (visual) s.changeType(visual.id, type);
    else s.addVisual(type, activeDatasetId);
  };

  return (
    <Pane title="Visualisations" width="w-64">
      <div className="border-b border-border p-2">
        {VISUAL_GROUPS.map(({ group, items }) => (
          <div key={group} className="mb-1.5">
            <p className="px-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted">{group}</p>
            <div className="grid grid-cols-6 gap-0.5">
              {items.map((d) => (
                <button
                  key={d.type}
                  type="button"
                  onClick={() => pick(d.type)}
                  title={visual ? `Changer en : ${d.label}` : `Ajouter : ${d.label}`}
                  aria-label={d.label}
                  aria-pressed={visual?.type === d.type}
                  className={clsx(
                    "flex aspect-square items-center justify-center rounded-md transition-colors",
                    visual?.type === d.type ? "bg-accent text-accent-fg" : "text-muted hover:bg-surface-2 hover:text-fg",
                  )}
                >
                  <d.icon className="size-4" aria-hidden />
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>

      {!visual ? (
        <p className="p-4 text-xs text-muted">Cliquez sur une icône pour ajouter un visuel, ou sélectionnez un visuel du canvas pour le configurer.</p>
      ) : (
        <>
          <div className="flex border-b border-border text-xs" role="tablist">
            {(["build", "format"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                onClick={() => setTab(t)}
                className={clsx("flex-1 py-2 font-medium", tab === t ? "border-b-2 border-accent text-fg" : "text-muted hover:text-fg")}
              >
                {t === "build" ? "Champs" : "Format"}
              </button>
            ))}
          </div>
          {tab === "build" ? <BuildTab visual={visual} /> : <FormatTab visual={visual} />}
        </>
      )}
    </Pane>
  );
}

function BuildTab({ visual }: { visual: Visual }) {
  const def = VISUALS[visual.type];
  if (!def.roles.length) return <p className="p-4 text-xs text-muted">Ce visuel n'utilise pas de champs : réglez-le dans l'onglet Format.</p>;
  return (
    <div>
      <p className="px-3 pt-3 text-[11px] font-medium">{def.label}</p>
      {def.roles.map((r) => (
        <RoleWell key={r.id} visual={visual} role={r} />
      ))}
    </div>
  );
}

function RoleWell({ visual, role }: { visual: Visual; role: RoleDef }) {
  const { profiles } = useStudioData();
  const [over, setOver] = useState(false);
  const bindings = visual.roles[role.id] ?? [];
  const profile = visual.dataset_id ? profiles.get(visual.dataset_id) : undefined;
  const s = useStudio.getState;

  const update = (index: number, patch: Partial<FieldBinding>) =>
    s().updateVisual(visual.id, (v) => {
      const list = v.roles[role.id];
      const b = list?.[index];
      if (list && b) list[index] = { ...b, ...patch };
    });
  const remove = (index: number) =>
    s().updateVisual(visual.id, (v) => {
      v.roles[role.id] = (v.roles[role.id] ?? []).filter((_, i) => i !== index);
      if (Object.values(v.roles).every((l) => !l.length)) v.dataset_id = null;
    });

  return (
    <div className="px-3 py-2">
      <p className="mb-1 flex items-center justify-between text-[11px] text-muted">
        <span>
          {role.label}
          {role.required && <span className="text-negative"> *</span>}
        </span>
        {role.max && <span>{bindings.length}/{role.max}</span>}
      </p>
      <div
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(FIELD_MIME)) {
            e.preventDefault();
            setOver(true);
          }
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          setOver(false);
          const raw = e.dataTransfer.getData(FIELD_MIME);
          if (!raw) return;
          e.preventDefault();
          const d = JSON.parse(raw) as DraggedField;
          const column = profiles.get(d.datasetId)?.columns.find((c) => c.name === d.field);
          if (column) s().dropField(visual.id, column, d.datasetId, role.id);
        }}
        className={clsx("min-h-8 space-y-1 rounded-md border border-dashed p-1", over ? "border-accent bg-accent/5" : "border-border")}
      >
        {!bindings.length && <p className="px-1.5 py-1 text-[11px] text-muted/70">Glissez un champ</p>}
        {bindings.map((b, i) => {
          const type = profile?.columns.find((c) => c.name === b.field)?.type;
          return (
            <div key={`${b.field}-${i}`} className="rounded bg-surface-2 px-2 py-1 text-[11px]">
              <div className="flex items-center gap-1">
                <span className="min-w-0 flex-1 truncate font-medium" title={bindingLabel(b)}>
                  {bindingLabel(b)}
                </span>
                <button type="button" onClick={() => remove(i)} aria-label={`Retirer ${b.field}`} className="text-muted hover:text-negative">
                  <X className="size-3" aria-hidden />
                </button>
              </div>
              {role.kind === "measure" && (
                <select
                  aria-label="Agrégation"
                  value={b.agg ?? "sum"}
                  onChange={(e) => update(i, { agg: e.target.value as Agg })}
                  className="mt-1 w-full rounded border border-border bg-surface px-1 py-0.5"
                >
                  {aggsFor(type).map((a) => (
                    <option key={a} value={a}>
                      {AGG_LABELS[a]}
                    </option>
                  ))}
                </select>
              )}
              {role.kind === "dimension" && type === "date" && (
                <select
                  aria-label="Période"
                  value={b.bin ?? ""}
                  onChange={(e) => update(i, { bin: (e.target.value || null) as DateBin | null })}
                  className="mt-1 w-full rounded border border-border bg-surface px-1 py-0.5"
                >
                  <option value="">Date exacte</option>
                  {(Object.keys(BIN_LABELS) as DateBin[]).map((bin) => (
                    <option key={bin} value={bin}>
                      {BIN_LABELS[bin]}
                    </option>
                  ))}
                </select>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FormatTab({ visual }: { visual: Visual }) {
  const def = VISUALS[visual.type];
  const report = useStudio((s) => s.report);
  const s = useStudio.getState;
  const sections = new Map<string, OptionDef[]>();
  const visible = def.options.filter((o) => !o.when || o.when({ ...def.defaults, ...visual.options }));
  for (const o of visible) sections.set(o.section ?? "Options", [...(sections.get(o.section ?? "Options") ?? []), o]);

  const value = (key: string) => visual.options[key] ?? def.defaults[key];
  const set = (key: string, v: unknown) => s().setOptions(visual.id, { [key]: v });

  return (
    <div>
      <Section title="Général">
        <label className="flex flex-col gap-1 text-[11px] text-muted">
          Titre (vide = automatique)
          <input
            value={visual.title ?? ""}
            onChange={(e) => s().updateVisual(visual.id, (v) => (v.title = e.target.value || null))}
            className="rounded-md border border-border bg-bg px-2 py-1 text-xs text-fg"
          />
        </label>
      </Section>
      <VisualStyleSection visual={visual} />
      {[...sections.entries()].map(([title, opts]) => (
        <Section key={title} title={title}>
          <div className="space-y-2">
            {opts.map((o) => {
              const v = value(o.key);
              const id = `opt-${visual.id}-${o.key}`;
              if (o.type === "boolean") {
                return (
                  <label key={o.key} htmlFor={id} className="flex cursor-pointer items-center justify-between gap-2 text-xs">
                    {o.label}
                    <input id={id} type="checkbox" checked={v === true} onChange={(e) => set(o.key, e.target.checked)} className="accent-[var(--accent)]" />
                  </label>
                );
              }
              const choices = o.key === "targetPage" ? (report?.pages ?? []).map((p) => ({ value: p.id, label: p.name })) : o.choices;
              return (
                <label key={o.key} htmlFor={id} className="flex flex-col gap-1 text-[11px] text-muted">
                  {o.label}
                  {o.type === "select" ? (
                    <select id={id} value={String(v ?? "")} onChange={(e) => set(o.key, e.target.value)} className="rounded-md border border-border bg-bg px-2 py-1 text-xs text-fg">
                      {o.key === "targetPage" && <option value="">—</option>}
                      {choices?.map((c) => (
                        <option key={c.value} value={c.value}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  ) : o.type === "textarea" ? (
                    <textarea id={id} rows={5} value={String(v ?? "")} onChange={(e) => set(o.key, e.target.value)} className="rounded-md border border-border bg-bg px-2 py-1 text-xs text-fg" />
                  ) : (
                    <input
                      id={id}
                      type={o.type === "number" ? "number" : "text"}
                      value={v === undefined || v === null ? "" : String(v)}
                      min={o.min}
                      max={o.max}
                      step={o.step}
                      placeholder={o.placeholder}
                      onChange={(e) => set(o.key, o.type === "number" ? (e.target.value === "" ? undefined : Number(e.target.value)) : e.target.value)}
                      className="rounded-md border border-border bg-bg px-2 py-1 text-xs text-fg"
                    />
                  )}
                </label>
              );
            })}
          </div>
        </Section>
      ))}
    </div>
  );
}
