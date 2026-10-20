/**
 * Choix du moteur d'IA (docs/SUITE.md §5.2) : règles pures, partagées par les volets et les réglages.
 *
 * - hors ligne, « Claude » n'est pas sélectionnable : le choix retombe sur « Auto » (= Ollama) ;
 * - « Auto » = Claude si l'application est en ligne **et** Claude disponible, sinon Ollama.
 */

import type { ClaudeModel, ProviderChoice, ProviderStatus } from "../types/ai";

/** Modèles Claude proposés (alias de la CLI), Sonnet par défaut. */
export const CLAUDE_MODELS: { value: ClaudeModel; label: string }[] = [
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
  { value: "haiku", label: "Haiku" },
];

/** Libellé d'un modèle Claude (« Sonnet ») ; identifiant tel quel s'il est inconnu. */
export function claudeModelLabel(model: string): string {
  const alias = model.replace(/\s*\(CLI\)$/, "");
  return CLAUDE_MODELS.find((m) => m.value === alias)?.label ?? alias;
}

/** Choix effectif : Claude hors ligne → Auto. */
export function effectiveProvider(choice: ProviderChoice, online: boolean): ProviderChoice {
  return !online && choice === "anthropic" ? "auto" : choice;
}

/** Moteur qui répondra : Claude explicitement, ou Auto en ligne avec Claude disponible ; sinon Ollama. */
export function respondingEngine(provider: ProviderChoice, online: boolean, claude: ProviderStatus | undefined): "anthropic" | "ollama" {
  if (provider === "anthropic") return "anthropic";
  if (provider === "auto" && online && claude?.available) return "anthropic";
  return "ollama";
}

/** Modèles Ollama proposés : installés, plus le modèle choisi s'il manque (affiché « non installé »). */
export function ollamaChoices(ollama: ProviderStatus | undefined, chosen: string | null): { value: string; label: string; missing: boolean }[] {
  const installed = ollama?.models ?? [];
  const current = chosen ?? ollama?.model ?? null;
  const list = installed.map((m) => ({ value: m, label: m, missing: false }));
  const has = (m: string) => installed.includes(m) || (!m.includes(":") && installed.includes(`${m}:latest`));
  if (current && !has(current)) list.unshift({ value: current, label: `${current} (non installé)`, missing: true });
  return list;
}

/** Modèle Ollama sélectionné dans la liste (`llama3.2` ↔ `llama3.2:latest`). */
export function ollamaSelected(ollama: ProviderStatus | undefined, chosen: string | null): string {
  const current = chosen ?? ollama?.model ?? "";
  const installed = ollama?.models ?? [];
  if (installed.includes(current)) return current;
  const latest = `${current}:latest`;
  return !current.includes(":") && installed.includes(latest) ? latest : current;
}
