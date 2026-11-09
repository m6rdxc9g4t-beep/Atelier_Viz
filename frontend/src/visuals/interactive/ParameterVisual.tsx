import { useEffect, useState } from "react";

import { VisualMessage } from "../common";
import { formatNumber } from "../format";
import type { VisualProps } from "../types";
import { parameterSpec } from "./parameters";

/** Décimales utiles pour un pas (0,25 → 2). */
const decimalsOf = (step: number) => {
  const s = String(step);
  return s.includes(".") ? Math.min(6, s.length - s.indexOf(".") - 1) : 0;
};

/**
 * Paramètre de simulation : curseur + saisie. La valeur va dans `options.value` ; les mesures de
 * la page qui citent `PARAM("nom", défaut)` se recalculent aussitôt.
 */
export function ParameterVisual(props: VisualProps) {
  const { visual, setOptions, editing } = props;
  const spec = parameterSpec(visual);
  const [draft, setDraft] = useState<string | null>(null);
  // Le curseur suit le pointeur ; la requête part au relâchement (pas une par pixel).
  const [sliding, setSliding] = useState<number | null>(null);
  useEffect(() => setSliding(null), [spec?.value]);

  if (!spec) return <VisualMessage>Nom de paramètre invalide : lettres, chiffres, espaces, « _ » ou « - ».</VisualMessage>;
  const fmt = {
    decimals: decimalsOf(spec.step),
    prefix: typeof visual.options.prefix === "string" ? visual.options.prefix : undefined,
    suffix: typeof visual.options.suffix === "string" ? visual.options.suffix : undefined,
  };
  const shown = sliding ?? spec.value;
  const commit = (v: number) => {
    if (Number.isFinite(v) && v !== spec.value) setOptions({ value: v });
    setSliding(null);
  };
  const id = `param-${visual.id}`;

  return (
    <div className="flex h-full flex-col justify-center gap-1.5 text-xs" onPointerDown={(e) => e.stopPropagation()}>
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="truncate text-[var(--muted)]">
          {spec.name}
        </label>
        <input
          type="text"
          inputMode="decimal"
          aria-label={`Valeur de « ${spec.name} »`}
          value={draft ?? formatNumber(shown, { decimals: fmt.decimals })}
          onFocus={(e) => {
            setDraft(String(spec.value).replace(".", ","));
            e.currentTarget.select();
          }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft !== null) commit(Number(draft.replace(/\s/g, "").replace(",", ".")));
            setDraft(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setDraft(null);
              e.currentTarget.blur();
            }
          }}
          className="w-20 rounded-md border border-[var(--grid)] bg-transparent px-1.5 py-0.5 text-right font-medium tabular-nums text-[var(--fg)]"
        />
      </div>
      <input
        id={id}
        type="range"
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={shown}
        aria-valuetext={formatNumber(shown, fmt)}
        onChange={(e) => setSliding(Number(e.target.value))}
        onPointerUp={(e) => commit(Number(e.currentTarget.value))}
        onKeyUp={(e) => commit(Number(e.currentTarget.value))}
        onBlur={(e) => sliding !== null && commit(Number(e.currentTarget.value))}
        className="w-full"
        style={{ accentColor: "var(--series-1)" }}
      />
      <div className="flex justify-between text-[10px] tabular-nums text-[var(--muted)]">
        <span>{formatNumber(spec.min, fmt)}</span>
        {spec.value !== spec.default ? (
          <button type="button" className="hover:text-[var(--fg)] hover:underline" onClick={() => commit(spec.default)}>
            Défaut : {formatNumber(spec.default, fmt)}
          </button>
        ) : (
          editing && <code className="truncate">PARAM("{spec.name}", {String(spec.default)})</code>
        )}
        <span>{formatNumber(spec.max, fmt)}</span>
      </div>
    </div>
  );
}
