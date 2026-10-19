import clsx from "clsx";
import { Download, Monitor, Moon, RotateCcw, Sun, Upload } from "lucide-react";
import { useRef, useState } from "react";

import { blend } from "../../theme/color";
import { ColorInput } from "../../theme/ColorInput";
import { DARK_PALETTE, LIGHT_PALETTE, PRESETS, type ReportTheme, type Shadow, importTheme, readTheme } from "../../theme/reportTheme";
import { useStudio } from "../store";
import { Pane, Section } from "./Pane";

/** Volet Thème du rapport : mode, préréglages, couleurs hexadécimales, palette, import / export JSON. */
export function ThemePane() {
  const report = useStudio((s) => s.report);
  const [error, setError] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  if (!report) return null;
  const theme = readTheme(report.theme);
  const s = useStudio.getState;
  const set = (t: ReportTheme | null) => s().setTheme(t ? (t as unknown as Record<string, unknown>) : {});
  const patch = (p: Partial<ReportTheme>) => theme && set({ ...theme, ...p, preset: "custom" });
  const patchVisual = (p: Partial<ReportTheme["visual"]>) => theme && set({ ...theme, preset: "custom", visual: { ...theme.visual, ...p } });
  const surface = theme ? blend(theme.visual.background, theme.page, theme.visual.backgroundOpacity / 100) : undefined;

  const exportTheme = () => {
    if (!theme) return;
    const blob = new Blob([JSON.stringify(theme, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `theme-${report.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <Pane title="Thème du rapport" width="w-72">
      <Section title="Mode">
        <div className="grid grid-cols-3 gap-1 rounded-md border border-border p-0.5 text-[11px]" role="radiogroup" aria-label="Mode du rapport">
          {[
            { mode: "auto", label: "Appli", icon: Monitor },
            { mode: "light", label: "Clair", icon: Sun },
            { mode: "dark", label: "Sombre", icon: Moon },
          ].map(({ mode, label, icon: Icon }) => {
            const active = (theme?.mode ?? "auto") === mode;
            return (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => set(mode === "auto" ? null : (PRESETS.find((p) => p.id === mode)?.theme ?? null))}
                className={clsx("flex items-center justify-center gap-1 rounded py-1.5", active ? "bg-surface-2 font-medium text-fg" : "text-muted hover:text-fg")}
              >
                <Icon className="size-3.5" aria-hidden /> {label}
              </button>
            );
          })}
        </div>
        {!theme && <p className="mt-2 text-[11px] text-muted">Le rapport suit le thème de l'application. Choisissez Clair ou Sombre pour personnaliser les couleurs.</p>}
      </Section>

      {theme && (
        <>
          <Section title="Style">
            <div className="grid grid-cols-2 gap-2">
              {PRESETS.filter((p) => p.theme.mode === theme.mode).map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => set(p.theme)}
                  aria-pressed={theme.preset === p.id}
                  title={p.description}
                  className={clsx("rounded-md border p-1.5 text-left text-[11px]", theme.preset === p.id ? "border-accent ring-1 ring-accent" : "border-border hover:bg-surface-2")}
                >
                  <PresetPreview t={p.theme} />
                  <span className="mt-1 block font-medium">{p.label}</span>
                </button>
              ))}
            </div>
            {theme.preset === "custom" && <p className="mt-2 text-[11px] text-muted">Thème personnalisé.</p>}
          </Section>

          <Section title="Fonds">
            <div className="space-y-2">
              <ColorInput label="Fond extérieur" value={theme.wallpaper} onChange={(v) => v && patch({ wallpaper: v })} />
              <ColorInput label="Fond de la page" value={theme.page} onChange={(v) => v && patch({ page: v })} />
              <ColorInput label="Fond des visuels" value={theme.visual.background} onChange={(v) => v && patchVisual({ background: v })} />
              <Slider
                label="Opacité des visuels"
                value={theme.visual.backgroundOpacity}
                min={0}
                max={100}
                unit=" %"
                hint="0 % = transparent"
                onChange={(v) => patchVisual({ backgroundOpacity: v })}
              />
            </div>
          </Section>

          <Section title="Bordures et relief">
            <div className="space-y-2">
              <label className="flex items-center justify-between text-xs">
                Bordure des visuels
                <input type="checkbox" checked={theme.visual.border} onChange={(e) => patchVisual({ border: e.target.checked })} className="accent-[var(--accent)]" />
              </label>
              {theme.visual.border && (
                <>
                  <ColorInput label="Couleur de bordure" value={theme.visual.borderColor} onChange={(v) => v && patchVisual({ borderColor: v })} />
                  <Slider label="Épaisseur" value={theme.visual.borderWidth} min={0} max={6} unit=" px" onChange={(v) => patchVisual({ borderWidth: v })} />
                </>
              )}
              <Slider label="Arrondi des angles" value={theme.visual.radius} min={0} max={24} unit=" px" onChange={(v) => patchVisual({ radius: v })} />
              <ShadowSelect value={theme.visual.shadow} onChange={(v) => patchVisual({ shadow: v })} />
            </div>
          </Section>

          <Section title="Texte et accents">
            <div className="space-y-2">
              <ColorInput label="Texte" value={theme.text} onChange={(v) => v && patch({ text: v })} against={surface} minContrast={4.5} />
              <ColorInput label="Texte secondaire (axes, légendes)" value={theme.muted} onChange={(v) => v && patch({ muted: v })} against={surface} minContrast={4.5} />
              <ColorInput label="Quadrillage" value={theme.grid} onChange={(v) => v && patch({ grid: v })} />
              <ColorInput label="Accent (sélection, boutons)" value={theme.accent} onChange={(v) => v && patch({ accent: v })} against={surface} />
            </div>
          </Section>

          <Section
            title="Couleurs des données"
            action={
              <button
                type="button"
                onClick={() => patch({ palette: theme.mode === "dark" ? DARK_PALETTE : LIGHT_PALETTE })}
                className="flex items-center gap-1 text-[10px] text-accent hover:underline"
                title="Palette validée : lisible par les daltoniens"
              >
                <RotateCcw className="size-3" aria-hidden /> Palette validée
              </button>
            }
          >
            <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
              {theme.palette.map((c, i) => (
                <ColorInput
                  key={i}
                  compact
                  label={`Couleur ${i + 1}`}
                  value={c}
                  against={surface}
                  onChange={(v) => v && patch({ palette: theme.palette.map((x, j) => (j === i ? v : x)) })}
                />
              ))}
            </div>
            <p className="mt-2 text-[10px] text-muted">L'ordre compte : la couleur 1 va à la plus grande série. La palette d'origine est vérifiée pour le daltonisme.</p>
          </Section>

          <Section title="Fichier de thème">
            <div className="flex gap-2">
              <button type="button" onClick={exportTheme} className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-xs hover:bg-surface-2">
                <Download className="size-3.5" aria-hidden /> Exporter
              </button>
              <button type="button" onClick={() => file.current?.click()} className="flex flex-1 items-center justify-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-xs hover:bg-surface-2">
                <Upload className="size-3.5" aria-hidden /> Importer
              </button>
            </div>
            <p className="mt-1.5 text-[10px] text-muted">JSON Atelier Viz, ou thème Power BI (dataColors, background, foreground).</p>
            {error && <p className="mt-1 text-[11px] text-negative">{error}</p>}
          </Section>
        </>
      )}
      {!theme && (
        <div className="px-3 py-3">
          <button type="button" onClick={() => file.current?.click()} className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-xs hover:bg-surface-2">
            <Upload className="size-3.5" aria-hidden /> Importer un thème (JSON)
          </button>
          {error && <p className="mt-1 text-[11px] text-negative">{error}</p>}
        </div>
      )}
      <input
        ref={file}
        type="file"
        accept="application/json,.json"
        className="sr-only"
        aria-label="Fichier de thème"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          try {
            set(importTheme(JSON.parse(await f.text())));
            setError(null);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
        }}
      />
    </Pane>
  );
}

function PresetPreview({ t }: { t: ReportTheme }) {
  const v = t.visual;
  return (
    <span className="flex h-12 items-center justify-center rounded" style={{ background: t.wallpaper }} aria-hidden>
      <span className="flex h-9 w-[85%] items-center justify-center rounded-sm" style={{ background: t.page }}>
        <span
          className="flex h-6 w-[80%] items-end gap-0.5 px-1.5 pb-1"
          style={{
            background: v.backgroundOpacity ? v.background : "transparent",
            border: v.border ? `${Math.max(1, v.borderWidth)}px solid ${v.borderColor}` : "none",
            borderRadius: Math.min(v.radius, 6),
            boxShadow: v.shadow !== "none" ? "0 1px 3px rgba(0,0,0,.15)" : undefined,
          }}
        >
          {t.palette.slice(0, 4).map((c, i) => (
            <span key={c} className="w-1.5 rounded-t-sm" style={{ background: c, height: `${[70, 45, 85, 30][i]}%` }} />
          ))}
        </span>
      </span>
    </span>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  unit = "",
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  unit?: string;
  hint?: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-[11px] text-muted">
      <span className="flex justify-between">
        {label}
        <span className="tabular-nums text-fg">
          {value}
          {unit}
        </span>
      </span>
      <input type="range" min={min} max={max} value={value} onChange={(e) => onChange(Number(e.target.value))} className="accent-[var(--accent)]" />
      {hint && <span className="text-[10px]">{hint}</span>}
    </label>
  );
}

export function ShadowSelect({ value, onChange, allowInherit }: { value: Shadow | undefined; onChange: (v: Shadow | undefined) => void; allowInherit?: boolean }) {
  return (
    <label className="flex flex-col gap-1 text-[11px] text-muted">
      Ombre
      <select
        value={value ?? ""}
        onChange={(e) => onChange((e.target.value || undefined) as Shadow | undefined)}
        className="rounded-md border border-border bg-bg px-2 py-1 text-xs text-fg"
      >
        {allowInherit && <option value="">Thème</option>}
        <option value="none">Aucune</option>
        <option value="soft">Légère</option>
        <option value="strong">Marquée</option>
      </select>
    </label>
  );
}
