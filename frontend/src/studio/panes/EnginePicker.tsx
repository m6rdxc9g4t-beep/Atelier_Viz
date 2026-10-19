import clsx from "clsx";
import { ShieldCheck, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { usePreferences } from "../../hooks/usePreferences";
import { useProviders } from "../../hooks/useProviders";
import type { ProviderChoice } from "../../types/ai";

const PROVIDERS: { value: ProviderChoice; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "ollama", label: "Ollama" },
  { value: "anthropic", label: "Claude" },
];

export interface Engine {
  choice: ProviderChoice;
  setChoice: (c: ProviderChoice) => void;
  /** Choix effectif (Claude hors ligne → Auto). */
  provider: ProviderChoice;
  online: boolean;
  /** Moteur qui répondra, en clair. */
  label: "Claude" | "Ollama (local)";
  down: boolean;
}

/** Choix du moteur d'IA, avec les règles du mode hors ligne (Claude seulement « En ligne »). */
export function useEngine(): Engine {
  const { prefs } = usePreferences();
  const { providers } = useProviders();
  const online = prefs?.online_mode ?? false;
  const [choice, setChoice] = useState<ProviderChoice>("auto");
  const provider: ProviderChoice = !online && choice === "anthropic" ? "auto" : choice;
  const claude = providers.find((p) => p.name === "anthropic");
  const ollama = providers.find((p) => p.name === "ollama");
  const label = provider === "anthropic" || (provider === "auto" && online && claude?.available) ? "Claude" : "Ollama (local)";
  const down = !!(label === "Claude" ? claude && !claude.available : ollama && !ollama.available);
  return { choice, setChoice, provider, online, label, down };
}

/** Sélecteur Auto / Ollama / Claude et note de confidentialité (ce qui est envoyé). */
export function EnginePicker({ engine, note }: { engine: Engine; note: string }) {
  return (
    <>
      <div className="grid grid-cols-3 gap-1 rounded-md border border-border p-0.5 text-[11px]" role="radiogroup" aria-label="Moteur d'IA">
        {PROVIDERS.map((p) => {
          const disabled = p.value === "anthropic" && !engine.online;
          return (
            <button
              key={p.value}
              type="button"
              role="radio"
              aria-checked={engine.provider === p.value}
              disabled={disabled}
              title={disabled ? "Activez le mode « En ligne » pour utiliser Claude" : undefined}
              onClick={() => engine.setChoice(p.value)}
              className={clsx(
                "rounded py-1.5 disabled:cursor-not-allowed disabled:opacity-40",
                engine.provider === p.value ? "bg-surface-2 font-medium text-fg" : "text-muted hover:text-fg",
              )}
            >
              {p.label}
            </button>
          );
        })}
      </div>
      <p className={clsx("mt-2 flex items-start gap-1.5 text-[11px]", engine.down ? "text-negative" : "text-muted")}>
        {engine.down ? <TriangleAlert className="mt-px size-3 shrink-0" aria-hidden /> : <ShieldCheck className="mt-px size-3 shrink-0" aria-hidden />}
        <span>{engine.down ? `${engine.label} n'est pas disponible (voir Réglages).` : `Réponse par ${engine.label}. ${note}`}</span>
      </p>
    </>
  );
}
