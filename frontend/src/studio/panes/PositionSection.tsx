import { useEffect, useState } from "react";

import type { Layout, Visual } from "../../types/report";
import { DEFAULT_PAGE, PAGE_PRESETS } from "../grid";
import { useStudio } from "../store";
import { Section } from "./Pane";

/** Champ numérique validé à la sortie (Entrée ou perte du focus), pour ne pas déplacer à chaque frappe. */
function NumberField({ label, value, min, onCommit }: { label: string; value: number; min: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Math.round(Number(draft.replace(",", ".")));
    if (Number.isFinite(n) && n >= min) onCommit(n);
    else setDraft(String(value));
  };
  return (
    <label className="flex items-center gap-1.5 rounded-md border border-border bg-bg px-2 py-1 text-[11px] text-muted focus-within:ring-1 focus-within:ring-focus">
      <span className="w-3 shrink-0 font-medium">{label}</span>
      <input
        inputMode="numeric"
        aria-label={label}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const step = (e.shiftKey ? 10 : 1) * (e.key === "ArrowUp" ? 1 : -1);
            const n = Math.max(min, (Number(draft) || value) + step);
            setDraft(String(n));
            onCommit(n);
          }
        }}
        className="w-full min-w-0 bg-transparent text-xs text-fg tabular-nums outline-none"
      />
      <span className="text-[10px]">px</span>
    </label>
  );
}

/** Position et taille d'un visuel, au pixel près (onglet Format). */
export function PositionSection({ visual }: { visual: Visual }) {
  const set = (patch: Partial<Layout>) => useStudio.getState().setLayout(visual.id, { ...visual.layout, ...patch }, `layout:${visual.id}`);
  const { x, y, w, h } = visual.layout;
  return (
    <Section title="Position et taille">
      <div className="grid grid-cols-2 gap-1.5">
        <NumberField label="X" value={x} min={0} onCommit={(v) => set({ x: v })} />
        <NumberField label="Y" value={y} min={0} onCommit={(v) => set({ y: v })} />
        <NumberField label="L" value={w} min={40} onCommit={(v) => set({ w: v })} />
        <NumberField label="H" value={h} min={30} onCommit={(v) => set({ h: v })} />
      </div>
      <p className="mt-1.5 text-[10px] text-muted">Flèches du clavier : 1 px · Maj + flèches : 10 px · Alt en glissant : sans repères.</p>
    </Section>
  );
}

/** Taille de la page courante : préréglages ou personnalisée (quand aucun visuel n'est sélectionné). */
export function PageSizeSection() {
  const page = useStudio((s) => s.page());
  if (!page) return null;
  const size = page.size ?? DEFAULT_PAGE;
  const preset = PAGE_PRESETS.find((p) => p.size.width === size.width && p.size.height === size.height)?.id ?? "custom";
  const set = (patch: Partial<typeof size>) => useStudio.getState().setPageSize({ ...size, ...patch });
  return (
    <Section title="Taille de la page">
      <select
        aria-label="Format de page"
        value={preset}
        onChange={(e) => {
          const p = PAGE_PRESETS.find((x) => x.id === e.target.value);
          if (p) set(p.size);
        }}
        className="mb-1.5 w-full rounded-md border border-border bg-bg px-2 py-1 text-xs text-fg"
      >
        {PAGE_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
        <option value="custom" disabled={preset !== "custom"}>
          Personnalisée
        </option>
      </select>
      <div className="grid grid-cols-2 gap-1.5">
        <NumberField label="L" value={size.width} min={320} onCommit={(v) => set({ width: Math.min(8000, v) })} />
        <NumberField label="H" value={size.height} min={240} onCommit={(v) => set({ height: Math.min(40000, v) })} />
      </div>
      <p className="mt-1.5 text-[10px] text-muted">La page s'allonge d'elle-même quand un visuel dépasse le bas.</p>
    </Section>
  );
}
