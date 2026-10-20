import { describe, expect, it } from "vitest";

import type { ProviderStatus } from "../types/ai";
import { CLAUDE_MODELS, claudeModelLabel, effectiveProvider, ollamaChoices, ollamaSelected, respondingEngine } from "./engine";

const status = (over: Partial<ProviderStatus>): ProviderStatus => ({ name: "ollama", available: true, model: "llama3.2", detail: null, models: [], ...over });

describe("moteur d'IA (docs/SUITE.md §5.2)", () => {
  it("hors ligne, Claude n'est pas sélectionnable : le choix retombe sur Auto", () => {
    expect(effectiveProvider("anthropic", false)).toBe("auto");
    expect(effectiveProvider("anthropic", true)).toBe("anthropic");
    expect(effectiveProvider("ollama", false)).toBe("ollama");
  });

  it("Auto = Claude si en ligne et disponible, sinon Ollama", () => {
    const up = status({ name: "anthropic", available: true });
    const down = status({ name: "anthropic", available: false });
    expect(respondingEngine("auto", true, up)).toBe("anthropic");
    expect(respondingEngine("auto", false, up)).toBe("ollama");
    expect(respondingEngine("auto", true, down)).toBe("ollama");
    expect(respondingEngine("auto", true, undefined)).toBe("ollama");
    expect(respondingEngine("ollama", true, up)).toBe("ollama");
    expect(respondingEngine("anthropic", true, down)).toBe("anthropic");
  });

  it("modèles Claude : Sonnet (défaut), Opus, Haiku", () => {
    expect(CLAUDE_MODELS.map((m) => m.value)).toEqual(["sonnet", "opus", "haiku"]);
    expect(claudeModelLabel("opus (CLI)")).toBe("Opus");
    expect(claudeModelLabel("claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
  });

  it("modèles Ollama : installés, plus le modèle choisi s'il manque", () => {
    const ollama = status({ models: ["llama3.2:latest", "qwen3:8b"] });
    expect(ollamaChoices(ollama, null).map((m) => m.value)).toEqual(["llama3.2:latest", "qwen3:8b"]);
    expect(ollamaSelected(ollama, null)).toBe("llama3.2:latest");
    expect(ollamaSelected(ollama, "qwen3:8b")).toBe("qwen3:8b");
    const missing = ollamaChoices(ollama, "gemma3");
    expect(missing[0]).toEqual({ value: "gemma3", label: "gemma3 (non installé)", missing: true });
    expect(ollamaChoices(status({ models: [] }), null)).toEqual([{ value: "llama3.2", label: "llama3.2 (non installé)", missing: true }]);
    expect(ollamaChoices(undefined, null)).toEqual([]);
  });
});
