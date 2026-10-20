import { Paintbrush, RotateCcw } from "lucide-react";

import { blend } from "../../theme/color";
import { ColorInput } from "../../theme/ColorInput";
import { DARK_PALETTE, LIGHT_PALETTE, type VisualStyle, effectiveOpacity, readTheme } from "../../theme/reportTheme";
import type { Visual } from "../../types/report";
import { useStudio } from "../store";
import { Section } from "./Pane";
import { ShadowSelect, Slider } from "./ThemePane";

/** Style d'un visuel : fond (hex + opacité), bordure, arrondi, ombre, titre, couleurs des données. */
export function VisualStyleSection({ visual }: { visual: Visual }) {
  const report = useStudio((s) => s.report);
  const theme = readTheme(report?.theme);
  const style = (visual.options.style ?? {}) as VisualStyle;
  const s = useStudio.getState;
  const set = (patch: Partial<VisualStyle>) => s().setVisualStyle(visual.id, patch);
  const inherited = theme?.visual;
  const bg = style.background ?? inherited?.background;
  const opacity = effectiveOpacity(style, inherited?.backgroundOpacity);
  const surface = theme && bg ? blend(bg, theme.page, opacity / 100) : undefined;
  const basePalette = theme?.palette ?? (document.documentElement.classList.contains("dark") ? DARK_PALETTE : LIGHT_PALETTE);
  const bare = visual.type === "button" || visual.type === "text";

  return (
    <>
      <Section
        title="Arrière-plan et bordure"
        action={
          <button
            type="button"
            onClick={() => s().setVisualStyle(visual.id, null)}
            className="flex items-center gap-1 text-[10px] text-accent-ink hover:underline"
            title="Revenir au style du thème"
          >
            <RotateCcw className="size-3" aria-hidden /> Thème
          </button>
        }
      >
        <div className="space-y-2">
          <ColorInput
            label="Couleur de fond"
            value={style.background}
            placeholder={inherited?.background ?? "thème"}
            allowEmpty
            onChange={(v) => set({ background: v })}
          />
          <Slider
            label="Opacité du fond"
            value={opacity}
            min={0}
            max={100}
            unit=" %"
            hint={bare ? "Boutons et textes : transparents par défaut" : "0 % = transparent"}
            onChange={(v) => set({ backgroundOpacity: v })}
          />
          <label className="flex flex-col gap-1 text-[11px] text-muted">
            Bordure
            <select
              value={style.border === undefined ? "" : style.border ? "on" : "off"}
              onChange={(e) => set({ border: e.target.value === "" ? undefined : e.target.value === "on" })}
              className="rounded-md border border-border bg-field px-2 py-1 text-xs text-fg"
            >
              <option value="">Thème</option>
              <option value="on">Afficher</option>
              <option value="off">Masquer</option>
            </select>
          </label>
          {style.border !== false && (
            <>
              <ColorInput
                label="Couleur de bordure"
                value={style.borderColor}
                placeholder={inherited?.borderColor ?? "thème"}
                allowEmpty
                onChange={(v) => set({ borderColor: v, border: v ? true : style.border })}
              />
              <Slider
                label="Épaisseur"
                value={style.borderWidth ?? inherited?.borderWidth ?? 1}
                min={0}
                max={6}
                unit=" px"
                onChange={(v) => set({ borderWidth: v, border: true })}
              />
            </>
          )}
          <Slider label="Arrondi" value={style.radius ?? inherited?.radius ?? 8} min={0} max={24} unit=" px" onChange={(v) => set({ radius: v })} />
          <ShadowSelect value={style.shadow} allowInherit onChange={(v) => set({ shadow: v })} />
          <Slider label="Marge intérieure" value={style.padding ?? (bare ? 6 : 12)} min={0} max={32} unit=" px" onChange={(v) => set({ padding: v })} />
        </div>
      </Section>

      {!bare && (
        <Section title="Titre">
          <div className="space-y-2">
            <label className="flex items-center justify-between text-xs">
              Afficher le titre
              <input
                type="checkbox"
                checked={style.showTitle !== false}
                onChange={(e) => set({ showTitle: e.target.checked ? undefined : false })}
                className="accent-[var(--accent)]"
              />
            </label>
            {style.showTitle !== false && (
              <>
                <ColorInput label="Couleur du titre" value={style.titleColor} placeholder={theme?.text ?? "thème"} allowEmpty against={surface} minContrast={4.5} onChange={(v) => set({ titleColor: v })} />
                <Slider label="Taille" value={style.titleSize ?? 13} min={10} max={28} unit=" px" onChange={(v) => set({ titleSize: v })} />
                <div className="grid grid-cols-2 gap-2">
                  <label className="flex flex-col gap-1 text-[11px] text-muted">
                    Alignement
                    <select
                      value={style.titleAlign ?? "left"}
                      onChange={(e) => set({ titleAlign: e.target.value as VisualStyle["titleAlign"] })}
                      className="rounded-md border border-border bg-field px-2 py-1 text-xs text-fg"
                    >
                      <option value="left">Gauche</option>
                      <option value="center">Centré</option>
                      <option value="right">Droite</option>
                    </select>
                  </label>
                  <label className="flex items-end gap-2 pb-1 text-xs">
                    <input type="checkbox" checked={style.titleBold === true} onChange={(e) => set({ titleBold: e.target.checked })} className="accent-[var(--accent)]" />
                    Gras
                  </label>
                </div>
              </>
            )}
            <ColorInput label="Couleur du texte (axes, valeurs)" value={style.textColor} placeholder={theme?.text ?? "thème"} allowEmpty against={surface} minContrast={4.5} onChange={(v) => set({ textColor: v })} />
          </div>
        </Section>
      )}

      {!bare && visual.type !== "slicer" && (
        <Section
          title="Couleurs des données"
          action={
            style.palette ? (
              <button type="button" onClick={() => set({ palette: undefined })} className="flex items-center gap-1 text-[10px] text-accent-ink hover:underline">
                <RotateCcw className="size-3" aria-hidden /> Thème
              </button>
            ) : (
              <button type="button" onClick={() => set({ palette: [...basePalette] })} className="flex items-center gap-1 text-[10px] text-accent-ink hover:underline">
                <Paintbrush className="size-3" aria-hidden /> Personnaliser
              </button>
            )
          }
        >
          {style.palette ? (
            <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
              {style.palette.map((c, i) => (
                <ColorInput
                  key={i}
                  compact
                  label={`Couleur ${i + 1}`}
                  value={c}
                  against={surface}
                  onChange={(v) => v && set({ palette: style.palette?.map((x, j) => (j === i ? v : x)) })}
                />
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-muted">Ce visuel utilise la palette du thème.</p>
          )}
        </Section>
      )}

      <div className="px-3 py-3">
        <button
          type="button"
          onClick={() => s().applyStyleToPage(visual.id)}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-xs hover:bg-surface-2"
        >
          <Paintbrush className="size-3.5" aria-hidden /> Appliquer ce style à toute la page
        </button>
      </div>
    </>
  );
}
