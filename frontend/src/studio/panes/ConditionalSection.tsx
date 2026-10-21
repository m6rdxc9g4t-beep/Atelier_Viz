import { Plus, X } from "lucide-react";
import { useState } from "react";

import type { Visual } from "../../types/report";
import { role } from "../../visuals/common";
import {
  type CondFormat,
  type CondRule,
  EMPTY_FORMAT,
  GLYPHS,
  RULE_COLORS,
  RULE_OPS,
  type RuleColor,
  type RuleOp,
  formatFor,
  isFormatted,
  toneCss,
} from "../../visuals/data/conditional";
import { bindingKey, bindingLabel } from "../../visuals/fields";
import { useStudio } from "../store";
import { Section } from "./Pane";

const field = "rounded-md border border-border bg-bg px-2 py-1 text-xs text-fg";

/** Nombre saisi à la française (« 1 000,5 ») ; null si invalide. */
export function parseNumber(text: string): number | null {
  const cleaned = text.replace(/[\s  ]/g, "").replace(",", ".");
  if (!cleaned || !/^[-+]?\d*\.?\d+(e[-+]?\d+)?$/i.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

/** Onglet Format des tables et matrices : mise en forme conditionnelle, mesure par mesure. */
export function ConditionalSection({ visual }: { visual: Visual }) {
  const measures = role(visual, "values");
  const [picked, setPicked] = useState<string | null>(null);
  const current = measures.find((m) => bindingKey(m) === picked) ?? measures[0];
  if (!current) {
    return (
      <Section title="Mise en forme conditionnelle">
        <p className="text-[11px] text-muted">Ajoutez une valeur pour la mettre en forme.</p>
      </Section>
    );
  }
  const key = bindingKey(current);
  const format = formatFor(visual, key);
  const save = (next: CondFormat) => {
    const all = { ...((visual.options.conditional as Record<string, CondFormat> | undefined) ?? {}), [key]: next };
    useStudio.getState().setOptions(visual.id, { conditional: all, dataBars: undefined });
  };
  const set = (patch: Partial<CondFormat>) => save({ ...format, ...patch });
  const setRule = (i: number, patch: Partial<CondRule>) => set({ rules: format.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });

  return (
    <Section
      title="Mise en forme conditionnelle"
      action={
        isFormatted(format) ? (
          <button type="button" onClick={() => save({ ...EMPTY_FORMAT })} className="text-[11px] text-accent hover:underline">
            Effacer
          </button>
        ) : undefined
      }
    >
      <div className="space-y-2.5">
        {measures.length > 1 && (
          <label className="flex flex-col gap-1 text-[11px] text-muted">
            Valeur
            <select value={key} onChange={(e) => setPicked(e.target.value)} className={field}>
              {measures.map((m) => (
                <option key={bindingKey(m)} value={bindingKey(m)}>
                  {bindingLabel(m)}
                  {isFormatted(formatFor(visual, bindingKey(m))) ? " •" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1 text-[11px] text-muted">
          Couleur de fond
          <select value={format.scale} onChange={(e) => set({ scale: e.target.value as CondFormat["scale"] })} className={field}>
            <option value="none">Aucune</option>
            <option value="sequential">Dégradé (du plus faible au plus fort)</option>
            <option value="diverging">Divergente (négatif / positif)</option>
          </select>
        </label>
        <label className="flex items-center justify-between gap-2 text-xs">
          Barres de données
          <input type="checkbox" checked={format.bars} onChange={(e) => set({ bars: e.target.checked })} className="accent-[var(--accent)]" />
        </label>
        <label className="flex flex-col gap-1 text-[11px] text-muted">
          Icônes
          <select value={format.icons} onChange={(e) => set({ icons: e.target.value as CondFormat["icons"] })} className={field}>
            <option value="none">Aucune</option>
            <option value="sign">
              Signe ({GLYPHS.up} positif, {GLYPHS.down} négatif)
            </option>
            <option value="terciles">
              Tiers ({GLYPHS.up} haut, {GLYPHS.flat} milieu, {GLYPHS.down} bas)
            </option>
          </select>
        </label>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px] text-muted">
            <span>Règles (la première vérifiée s'applique)</span>
            {format.rules.length > 0 && (
              <span className="flex rounded border border-border p-px" role="group" aria-label="Les règles colorent">
                {(["background", "text"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={format.rulesTarget === t}
                    onClick={() => set({ rulesTarget: t })}
                    className={format.rulesTarget === t ? "rounded-sm bg-surface-2 px-1.5 text-fg" : "px-1.5"}
                  >
                    {t === "background" ? "Fond" : "Texte"}
                  </button>
                ))}
              </span>
            )}
          </div>
          {format.rules.map((r, i) => (
            <RuleRow key={i} rule={r} onChange={(patch) => setRule(i, patch)} onRemove={() => set({ rules: format.rules.filter((_, j) => j !== i) })} />
          ))}
          <button
            type="button"
            onClick={() => set({ rules: [...format.rules, { op: "gt", value: 0, color: "positive" }] })}
            className="flex items-center gap-1 text-[11px] text-accent hover:underline"
          >
            <Plus className="size-3" aria-hidden /> Ajouter une règle
          </button>
        </div>
      </div>
    </Section>
  );
}

function NumberBox({ value, onCommit, label }: { value: number; onCommit: (n: number) => void; label: string }) {
  const [draft, setDraft] = useState(String(value).replace(".", ","));
  return (
    <input
      aria-label={label}
      value={draft}
      inputMode="decimal"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const n = parseNumber(draft);
        if (n === null) setDraft(String(value).replace(".", ","));
        else onCommit(n);
      }}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      className={`${field} w-full min-w-0 tabular-nums`}
    />
  );
}

function RuleRow({ rule, onChange, onRemove }: { rule: CondRule; onChange: (p: Partial<CondRule>) => void; onRemove: () => void }) {
  return (
    <div className="grid grid-cols-[3.4rem_1fr_auto] items-center gap-1">
      <select aria-label="Condition" value={rule.op} onChange={(e) => onChange({ op: e.target.value as RuleOp })} className={field}>
        {RULE_OPS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <div className="flex min-w-0 items-center gap-1">
        <NumberBox label="Seuil" value={rule.value} onCommit={(value) => onChange({ value })} />
        {rule.op === "between" && (
          <>
            <span className="text-[10px] text-muted">et</span>
            <NumberBox label="Seuil haut" value={rule.value2 ?? rule.value} onCommit={(value2) => onChange({ value2 })} />
          </>
        )}
      </div>
      <div className="flex items-center gap-0.5">
        <select
          aria-label="Couleur"
          value={rule.color}
          onChange={(e) => onChange({ color: e.target.value as RuleColor })}
          className={`${field} w-[4.2rem]`}
          style={{ color: toneCss(rule.color) }}
        >
          {RULE_COLORS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <button type="button" onClick={onRemove} aria-label="Supprimer la règle" className="rounded p-0.5 text-muted hover:text-negative">
          <X className="size-3" aria-hidden />
        </button>
      </div>
    </div>
  );
}
