import clsx from "clsx";
import { TriangleAlert, X } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { HEX_RE, normalizeHex } from "./color";
import { contrastWarning } from "./reportTheme";

interface ColorInputProps {
  label: string;
  value: string | undefined;
  onChange: (hex: string | undefined) => void;
  /** Valeur affichée quand aucune couleur n'est choisie (ex. couleur du thème). */
  placeholder?: string;
  /** Autorise « vide » (= hériter du thème). */
  allowEmpty?: boolean;
  /** Fond sur lequel la couleur sera posée, pour l'avertissement de contraste. */
  against?: string;
  minContrast?: number;
  compact?: boolean;
}

/** Sélecteur de couleur : nuancier natif + saisie hexadécimale (#2a78d6 ou #28d). */
export function ColorInput({ label, value, onChange, placeholder, allowEmpty, against, minContrast = 3, compact }: ColorInputProps) {
  const id = useId();
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);
  const valid = draft === "" || HEX_RE.test(draft.trim());
  const shown = value ?? placeholder ?? "#000000";
  const warning = against && value ? contrastWarning(value, against, minContrast) : null;

  return (
    <div className={clsx("flex flex-col gap-1", compact ? "text-[10px]" : "text-[11px]")}>
      {!compact && (
        <label htmlFor={id} className="text-muted">
          {label}
        </label>
      )}
      <div className="flex items-center gap-1.5">
        <label
          className="relative size-6 shrink-0 cursor-pointer overflow-hidden rounded border border-border"
          style={{ background: HEX_RE.test(shown) ? shown : "transparent" }}
          title={`${label} — ouvrir le nuancier`}
        >
          <input
            type="color"
            aria-label={`${label} (nuancier)`}
            value={HEX_RE.test(shown) ? normalizeHex(shown) : "#000000"}
            onChange={(e) => onChange(e.target.value)}
            className="absolute inset-0 cursor-pointer opacity-0"
          />
        </label>
        <input
          id={id}
          aria-label={compact ? label : undefined}
          value={draft}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(e) => {
            const next = e.target.value;
            setDraft(next);
            if (HEX_RE.test(next.trim())) onChange(normalizeHex(next));
            else if (next === "" && allowEmpty) onChange(undefined);
          }}
          onBlur={() => !valid && setDraft(value ?? "")}
          aria-invalid={!valid}
          className={clsx(
            "min-w-0 flex-1 rounded border bg-bg px-1.5 py-0.5 font-mono text-[11px] uppercase text-fg",
            valid ? "border-border" : "border-negative",
          )}
        />
        {allowEmpty && value && (
          <button type="button" onClick={() => onChange(undefined)} aria-label={`Rétablir ${label} (thème)`} className="text-muted hover:text-fg">
            <X className="size-3" aria-hidden />
          </button>
        )}
      </div>
      {warning && (
        <p className="flex items-center gap-1 text-[10px] text-negative">
          <TriangleAlert className="size-3 shrink-0" aria-hidden /> {warning}
        </p>
      )}
    </div>
  );
}
