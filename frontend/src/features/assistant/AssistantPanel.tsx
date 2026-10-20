import clsx from "clsx";
import { Database, SendHorizontal, Sparkles, X } from "lucide-react";
import { type FormEvent, useState } from "react";

import { api } from "../../lib/api";
import { EnginePicker, useEngine } from "../../components/ai/EnginePicker";
import type { ChatMessage, ProviderName } from "../../types/ai";
import type { DatasetSummary } from "../../types/dataset";
import { RichText } from "./RichText";

interface DisplayedMessage extends ChatMessage {
  provider?: ProviderName;
  error?: boolean;
}

const SYSTEM_PROMPT =
  "Tu es l'assistant d'une application de BI. Réponds en français, de façon concise, " +
  "et propose des visualisations adaptées aux données décrites.";

interface AssistantPanelProps {
  /** Jeu de données sélectionné : son schéma + un échantillon peuvent être joints aux questions. */
  dataset: Pick<DatasetSummary, "id" | "name"> | null;
  onClose?: () => void;
}

/** Chat latéral : envoie la conversation à /api/ai/chat avec le moteur choisi (docs/SUITE.md §5.2). */
export function AssistantPanel({ dataset, onClose }: AssistantPanelProps) {
  // Moteur commun à tous les écrans d'IA (mémorisé) ; hors ligne, Claude retombe sur Auto (= Ollama).
  const engine = useEngine();
  const provider = engine.provider;
  const [messages, setMessages] = useState<DisplayedMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [useDataset, setUseDataset] = useState(true);

  async function send(event: FormEvent) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || pending) return;

    const history: ChatMessage[] = [
      ...messages.filter((m) => !m.error).map(({ role, content: c }) => ({ role, content: c })),
      { role: "user", content },
    ];
    setMessages((m) => [...m, { role: "user", content }]);
    setDraft("");
    setPending(true);
    try {
      const res = await api.chat({
        messages: history,
        provider,
        task: "simple",
        system: SYSTEM_PROMPT,
        dataset_id: useDataset && dataset ? dataset.id : null,
      });
      setMessages((m) => [...m, { role: "assistant", content: res.content, provider: res.provider }]);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      setMessages((m) => [...m, { role: "assistant", content: text, error: true }]);
    } finally {
      setPending(false);
    }
  }

  return (
    <aside className="atelier-pop fixed inset-y-0 right-0 z-40 flex w-full max-w-sm flex-col border-l border-border bg-surface shadow-xl lg:static lg:z-auto lg:w-80 lg:shadow-none">
      <header className="flex h-12 items-center justify-between gap-2 border-b border-border px-4">
        <h2 className="mr-auto flex items-center gap-2 text-sm font-semibold">
          <Sparkles className="size-4 text-accent-ink" aria-hidden />
          Assistant
        </h2>
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Fermer l'assistant" className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg">
            <X className="size-4" aria-hidden />
          </button>
        )}
      </header>

      <div className="border-b border-border px-4 py-3">
        <EnginePicker
          engine={engine}
          note={
            useDataset && dataset
              ? `Envoyé : votre conversation, les noms de colonnes, leurs statistiques et 5 lignes d'exemple de « ${dataset.name} ».`
              : "Seule votre conversation est envoyée (aucune donnée du jeu)."
          }
        />
      </div>

      {dataset && (
        <label className="flex cursor-pointer items-center gap-2 border-b border-border px-4 py-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={useDataset}
            onChange={(e) => setUseDataset(e.target.checked)}
            className="accent-[var(--accent)]"
          />
          <Database className="size-3.5 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">
            Joindre le schéma de <span className="font-medium text-fg">{dataset.name}</span>
          </span>
        </label>
      )}

      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4" aria-live="polite">
        {messages.length === 0 && (
          <p className="text-sm text-muted">
            Ex. : « Quel graphique pour comparer les ventes et l'objectif par mois ? »
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={clsx(
              "max-w-[90%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm",
              m.role === "user" && "self-end bg-accent text-accent-fg",
              m.role === "assistant" && !m.error && "self-start bg-surface-2",
              m.error && "self-start border border-negative/40 text-negative",
            )}
          >
            {m.role === "assistant" && !m.error ? <RichText text={m.content} /> : m.content}
            {m.provider && (
              <span className="mt-1 block text-[10px] uppercase tracking-wide text-muted">
                via {m.provider === "ollama" ? "Ollama" : "Claude"}
              </span>
            )}
          </div>
        ))}
        {pending && <p className="text-xs text-muted">Réflexion…</p>}
      </div>

      <form onSubmit={send} className="flex gap-2 border-t border-border p-3">
        <label htmlFor="assistant-input" className="sr-only">
          Message à l'assistant
        </label>
        <input
          id="assistant-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Demandez un graphique…"
          className="min-w-0 flex-1 rounded-md border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-focus"
        />
        <button
          type="submit"
          disabled={pending || !draft.trim()}
          aria-label="Envoyer"
          className="btn-signature rounded-md bg-accent px-3 text-accent-fg disabled:opacity-40"
        >
          <SendHorizontal className="size-4" aria-hidden />
        </button>
      </form>
    </aside>
  );
}
