import clsx from "clsx";
import { ShieldCheck, TriangleAlert } from "lucide-react";
import { useId } from "react";

import { usePreferences } from "../../hooks/usePreferences";
import { useProviders } from "../../hooks/useProviders";
import { CLAUDE_MODELS, claudeModelLabel, effectiveProvider, ollamaChoices, ollamaSelected, respondingEngine } from "../../lib/engine";
import type { ClaudeModel, ProviderChoice, ProviderStatus } from "../../types/ai";

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
  /** Modèle du moteur qui répondra (« Sonnet », « qwen3:8b »). */
  model: string | null;
  down: boolean;
  claude: ProviderStatus | undefined;
  ollama: ProviderStatus | undefined;
  claudeModel: ClaudeModel;
  ollamaModel: string | null;
  setClaudeModel: (m: ClaudeModel) => void;
  setOllamaModel: (m: string | null) => void;
}

/**
 * Choix du moteur d'IA (docs/SUITE.md §5.2), mémorisé dans les préférences et partagé par tous les
 * écrans d'IA : Auto · Ollama · Claude, modèle Claude (Sonnet / Opus / Haiku) et modèle Ollama.
 */
export function useEngine(): Engine {
  const { prefs, update } = usePreferences();
  const { providers, refresh } = useProviders();
  const online = prefs?.online_mode ?? false;
  const choice = prefs?.ai_provider ?? "auto";
  const provider = effectiveProvider(choice, online);
  const claude = providers.find((p) => p.name === "anthropic");
  const ollama = providers.find((p) => p.name === "ollama");
  const engine = respondingEngine(provider, online, claude);
  const label = engine === "anthropic" ? "Claude" : "Ollama (local)";
  const status = engine === "anthropic" ? claude : ollama;
  const down = !!(status && !status.available);
  const claudeModel = prefs?.claude_model ?? "sonnet";
  const ollamaModel = prefs?.ollama_model ?? null;
  const model = engine === "anthropic" ? (claude?.models.length ? claudeModelLabel(claudeModel) : claude ? claudeModelLabel(claude.model) : null) : (ollamaModel ?? ollama?.model ?? null);
  return {
    choice,
    setChoice: (c) => void update({ ai_provider: c }),
    provider,
    online,
    label,
    model,
    down,
    claude,
    ollama,
    claudeModel,
    ollamaModel,
    // Le modèle change l'état affiché (Ollama : modèle installé ?) : revérification après l'enregistrement.
    setClaudeModel: (m) => void update({ claude_model: m }).then(() => refresh()),
    setOllamaModel: (m) => void update({ ollama_model: m }).then(() => refresh()),
  };
}

/** Sélecteur Auto / Ollama / Claude, modèle du moteur qui répondra et ligne bouclier (ce qui est envoyé). */
export function EnginePicker({ engine, note }: { engine: Engine; note: string }) {
  const modelId = useId();
  const claudeSide = engine.label === "Claude";
  const ollamaList = ollamaChoices(engine.ollama, engine.ollamaModel);
  // Mode API (clé Console) : modèle fixé par la configuration, pas de choix proposé.
  const claudeChoosable = !!engine.claude?.models.length;
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
      <div className="mt-2 flex items-center gap-2 text-[11px] text-muted">
        <label htmlFor={modelId} className="shrink-0">
          Modèle {claudeSide ? "Claude" : "Ollama"}
        </label>
        {claudeSide ? (
          claudeChoosable ? (
            <select
              id={modelId}
              value={engine.claudeModel}
              onChange={(e) => engine.setClaudeModel(e.target.value as ClaudeModel)}
              className="min-w-0 flex-1 rounded border border-border bg-field px-1.5 py-0.5 text-xs text-fg"
            >
              {CLAUDE_MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          ) : (
            <span id={modelId} className="truncate text-fg">
              {engine.model ?? "—"}
            </span>
          )
        ) : (
          <select
            id={modelId}
            value={ollamaSelected(engine.ollama, engine.ollamaModel)}
            disabled={!ollamaList.length}
            onChange={(e) => engine.setOllamaModel(e.target.value)}
            className="min-w-0 flex-1 rounded border border-border bg-field px-1.5 py-0.5 text-xs text-fg disabled:opacity-50"
          >
            {ollamaList.length ? (
              ollamaList.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))
            ) : (
              <option value={engine.model ?? ""}>{engine.model ?? "—"}</option>
            )}
          </select>
        )}
      </div>
      <p className={clsx("mt-2 flex items-start gap-1.5 text-[11px]", engine.down ? "text-negative" : "text-muted")}>
        {engine.down ? <TriangleAlert className="mt-px size-3 shrink-0" aria-hidden /> : <ShieldCheck className="mt-px size-3 shrink-0" aria-hidden />}
        <span>{engine.down ? `${engine.label} n'est pas disponible (voir Réglages).` : `Réponse par ${engine.label}${engine.model ? ` (${engine.model})` : ""}. ${note}`}</span>
      </p>
    </>
  );
}
