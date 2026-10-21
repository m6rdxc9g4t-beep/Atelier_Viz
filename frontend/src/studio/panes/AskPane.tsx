import { CircleHelp, Loader2, Plus, Send, ShieldCheck, Trash2 } from "lucide-react";
import { useState } from "react";
import { create } from "zustand";

import { EnginePicker, useEngine } from "../../components/ai/EnginePicker";
import { type Asked, ask, suggestions } from "../../summary/ask";
import { VISUALS } from "../../visuals/registry";
import { useStudioData } from "../context";
import { useStudio } from "../store";
import { Pane } from "./Pane";

interface AskEntry {
  id: string;
  question: string;
  datasetId: string;
  status: "pending" | "done" | "error";
  asked?: Asked;
  error?: string;
  added?: boolean;
}

/** Questions de la session, par rapport (gardées tant que l'application est ouverte). */
const useAsk = create<{ byReport: Record<string, AskEntry[]>; set: (reportId: string, fn: (l: AskEntry[]) => AskEntry[]) => void }>((set) => ({
  byReport: {},
  set: (reportId, fn) => set((s) => ({ byReport: { ...s.byReport, [reportId]: fn(s.byReport[reportId] ?? []).slice(0, 20) } })),
}));

const noop = () => undefined;
const NONE: AskEntry[] = [];
let counter = 0;

/** Volet « Demander » : une question en français → un visuel calculé ici et une réponse aux chiffres vérifiés. */
export function AskPane() {
  const reportId = useStudio((s) => s.report?.id ?? "");
  const report = useStudio((s) => s.report);
  const page = useStudio((s) => s.page());
  const selection = useStudio((s) => s.selection);
  const editing = useStudio((s) => s.mode) === "edit";
  const entries = useAsk((s) => s.byReport[reportId] ?? NONE);
  const { datasets, profiles, activeDatasetId, setActiveDatasetId } = useStudioData();
  const engine = useEngine();
  const [draft, setDraft] = useState("");
  const pending = entries.some((e) => e.status === "pending");
  const profile = activeDatasetId ? profiles.get(activeDatasetId) : undefined;
  const update = (fn: (l: AskEntry[]) => AskEntry[]) => useAsk.getState().set(reportId, fn);

  const submit = async (text = draft) => {
    const question = text.trim();
    if (question.length < 3 || !activeDatasetId || !page || pending) return;
    const id = `ask-${Date.now()}-${counter++}`;
    const datasetId = activeDatasetId;
    update((l) => [{ id, question, datasetId, status: "pending" }, ...l]);
    setDraft("");
    try {
      const asked = await ask({ question, datasetId, page, selection, profiles, provider: engine.provider, previewId: id });
      update((l) => l.map((e) => (e.id === id ? { ...e, status: "done", asked } : e)));
    } catch (err) {
      update((l) => l.map((e) => (e.id === id ? { ...e, status: "error", error: err instanceof Error ? err.message : String(err) } : e)));
    }
  };

  const add = (entry: AskEntry) => {
    if (!entry.asked) return;
    const ids = useStudio.getState().addGenerated([entry.asked.proposal], entry.datasetId);
    if (ids.length) {
      update((l) => l.map((e) => (e.id === entry.id ? { ...e, added: true } : e)));
      useStudio.getState().notify("Visuel ajouté à la page.");
    }
  };

  return (
    <Pane title="Demander" width="w-96">
      <div className="space-y-2 border-b border-border p-3">
        <div className="flex items-center gap-2">
          <select
            aria-label="Jeu de données interrogé"
            value={activeDatasetId ?? ""}
            onChange={(e) => setActiveDatasetId(e.target.value)}
            className="min-w-0 flex-1 rounded-md border border-border bg-field px-2 py-1 text-xs"
          >
            {datasets.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="flex items-end gap-1.5"
        >
          <textarea
            aria-label="Votre question"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            rows={2}
            maxLength={500}
            placeholder="Ex. Quelle région a le plus gros chiffre d'affaires ?"
            className="min-w-0 flex-1 resize-none rounded-md border border-border bg-field px-2 py-1.5 text-xs outline-none focus:border-focus"
          />
          <button
            type="submit"
            disabled={pending || draft.trim().length < 3 || engine.down}
            aria-label="Poser la question"
            className="atelier-btn-primary flex h-8 items-center gap-1 rounded-md bg-accent px-2.5 text-xs font-medium text-accent-fg disabled:opacity-40"
          >
            {pending ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Send className="size-3.5" aria-hidden />}
          </button>
        </form>
        <EnginePicker engine={engine} note="Le moteur choisit le visuel puis rédige la réponse." />
        {!entries.length && (
          <div className="flex flex-wrap gap-1">
            {suggestions(profile).map((s) => (
              <button key={s} type="button" disabled={engine.down} onClick={() => void submit(s)} className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted hover:border-accent-ink hover:text-accent-ink disabled:opacity-40">
                {s}
              </button>
            ))}
          </div>
        )}
        <p className="flex items-start gap-1 text-[10px] leading-snug text-muted">
          <ShieldCheck className="mt-px size-3 shrink-0" aria-hidden /> Le calcul se fait ici, avec les filtres de la page ; l'IA ne reçoit que le schéma, 5 lignes d'exemple et les chiffres agrégés du résultat. Chaque chiffre de la réponse est vérifié.
        </p>
      </div>

      <ol className="space-y-3 p-3" aria-label="Questions">
        {entries.map((e) => (
          <li key={e.id} className="atelier-card rounded-lg border border-border bg-surface p-2.5">
            <p className="flex items-start gap-1.5 text-xs font-medium">
              <CircleHelp className="mt-px size-3.5 shrink-0 text-accent-ink" aria-hidden /> {e.question}
            </p>
            {e.status === "pending" && (
              <p className="mt-2 flex items-center gap-1.5 text-[11px] text-muted">
                <Loader2 className="size-3 animate-spin" aria-hidden /> {engine.label} cherche le bon visuel…
              </p>
            )}
            {e.status === "error" && <p className="mt-2 text-[11px] text-negative">{e.error}</p>}
            {e.status === "done" && e.asked && <Answer entry={e} report={report} editing={editing} onAdd={() => add(e)} />}
            <button
              type="button"
              onClick={() => update((l) => l.filter((x) => x.id !== e.id))}
              disabled={e.status === "pending"}
              className="mt-1 flex items-center gap-1 text-[10px] text-muted hover:text-negative disabled:opacity-0"
            >
              <Trash2 className="size-3" aria-hidden /> Retirer
            </button>
          </li>
        ))}
      </ol>
    </Pane>
  );
}

function Answer({ entry, report, editing, onAdd }: { entry: AskEntry; report: ReturnType<typeof useStudio.getState>["report"]; editing: boolean; onAdd: () => void }) {
  const { profiles } = useStudioData();
  const asked = entry.asked as Asked;
  const def = VISUALS[asked.visual.type];
  const Component = def.component;
  return (
    <div className="mt-2 space-y-2">
      {asked.answer ? (
        <div>
          <p className="text-xs leading-relaxed">{asked.answer.answer}</p>
          <p className="mt-0.5 flex items-center gap-1 text-[10px] text-muted">
            <ShieldCheck className="size-3 text-positive" aria-hidden /> Chiffres vérifiés{asked.answer.warnings.length ? ` · ${asked.answer.warnings.length} phrase(s) écartée(s)` : ""}
          </p>
        </div>
      ) : (
        <p className="text-[11px] text-muted">{asked.answerError ? `Réponse rédigée indisponible : ${asked.answerError}` : "Voici le visuel qui répond à la question."}</p>
      )}
      <figure className="rounded-md border border-border bg-bg p-2">
        <figcaption className="mb-1 truncate text-[11px] font-medium">{asked.visual.title ?? def.label}</figcaption>
        <div className="h-44">
          {report && (
            <Component
              visual={asked.visual}
              def={def}
              dataset={profiles.get(entry.datasetId)}
              result={asked.result}
              filters={[]}
              selection={null}
              onSelect={noop}
              setOptions={noop}
              actions={{ pages: report.pages, pageId: "", reportName: report.name, goToPage: noop, resetFilters: noop, applyBookmark: () => false, activeFilters: [] }}
              editing={false}
            />
          )}
        </div>
      </figure>
      {editing && (
        <button
          type="button"
          disabled={entry.added}
          onClick={onAdd}
          className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium hover:bg-surface-2 disabled:opacity-50"
        >
          <Plus className="size-3" aria-hidden /> {entry.added ? "Ajouté à la page" : "Ajouter à la page"}
        </button>
      )}
    </div>
  );
}
