import { BadgeCheck, ClipboardCopy, FileText, Loader2, RotateCcw, ScrollText, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api } from "../../lib/api";
import { loadPageFacts, summaryRequest, summaryText } from "../../summary/pageSummary";
import type { SummaryResponse, VisualFacts } from "../../types/summary";
import { useStudioData } from "../context";
import { useStudio } from "../store";
import { EnginePicker, useEngine } from "./EnginePicker";
import { Pane, Section } from "./Pane";

/** Fait défiler jusqu'au visuel et le sélectionne (mode édition). */
function focusVisual(id: string) {
  document.querySelector(`[data-visual-id="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  if (useStudio.getState().mode === "edit") useStudio.getState().select(id);
}

/** Volet « Résumé » : synthèse de la page par l'IA, chaque chiffre vérifié contre les données. */
export function SummaryPane() {
  const report = useStudio((s) => s.report);
  const pageId = useStudio((s) => s.pageId);
  const selection = useStudio((s) => s.selection);
  const editing = useStudio((s) => s.mode === "edit");
  const { profiles } = useStudioData();
  const engine = useEngine();
  const [points, setPoints] = useState(4);
  const [facts, setFacts] = useState<VisualFacts[] | null>(null);
  const [pending, setPending] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SummaryResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const page = report?.pages.find((p) => p.id === pageId);

  // Faits recalculés quand la page, ses filtres ou la sélection changent (aucun appel à l'IA).
  useEffect(() => {
    if (!page) return;
    let alive = true;
    setFacts(null);
    loadPageFacts(page, selection, profiles)
      .then((f) => alive && setFacts(f))
      .catch(() => alive && setFacts([]));
    return () => {
      alive = false;
    };
  }, [page, selection, profiles]);

  useEffect(() => {
    setResult(null);
    setError(null);
  }, [pageId]);

  useEffect(() => {
    if (!pending) return;
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 500);
    return () => clearInterval(t);
  }, [pending]);

  if (!report || !page) return null;
  const count = facts?.reduce((t, v) => t + v.facts.length, 0) ?? 0;
  const titleOf = (id: string) => facts?.find((v) => v.id === id)?.title ?? "visuel";

  const run = async () => {
    if (!facts?.length || pending) return;
    setPending(true);
    setElapsed(0);
    setError(null);
    setResult(null);
    abort.current = new AbortController();
    try {
      setResult(await api.summarizePage(summaryRequest(report.name, page, selection, profiles, facts, engine.provider, points), abort.current.signal));
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  const copy = async () => {
    if (!result) return;
    const text = [result.headline, ...result.points.map((p) => `- ${p.text}`)].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Copie impossible : le navigateur refuse l'accès au presse-papiers.");
    }
  };

  const insert = () => {
    if (!result) return;
    // Hauteur : une ligne de 20 px par point (+ titre), en rangées de 24 px, et une rangée de marge pour les retours à la ligne.
    const rows = Math.ceil(((1 + result.points.length) * 20 + 16) / 24) + 1;
    const id = useStudio.getState().insertTextAtTop(summaryText(result), rows);
    useStudio.getState().notify("Synthèse insérée en haut de la page (Ctrl+Z pour annuler).");
    if (id) setTimeout(() => focusVisual(id), 50);
  };

  return (
    <Pane title="Résumé de la page" width="w-80">
      <Section title="Moteur">
        <EnginePicker
          engine={engine}
          note={
            facts === null
              ? "Calcul des chiffres de la page…"
              : `Seuls ${count} chiffres agrégés de ${facts.length} visuel${facts.length > 1 ? "s" : ""} sont envoyés, aucune ligne de données.`
          }
        />
        {facts && facts.length > 0 && (
          <details className="mt-2 text-[11px] text-muted">
            <summary className="cursor-pointer hover:text-fg">Voir les chiffres envoyés</summary>
            <ul className="mt-1.5 space-y-1.5">
              {facts.map((v) => (
                <li key={v.id}>
                  <p className="font-medium text-fg">{v.title}</p>
                  <ul className="list-disc pl-4">
                    {v.facts.map((f) => (
                      <li key={f}>{f}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Section>

      <Section title={`Page « ${page.name} »`}>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-muted">
            <select value={points} onChange={(e) => setPoints(Number(e.target.value))} className="rounded border border-border bg-bg px-1 py-0.5 text-xs text-fg">
              {[3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            points au plus
          </label>
          {pending ? (
            <button type="button" onClick={() => abort.current?.abort()} className="ml-auto flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs">
              <Loader2 className="size-3.5 animate-spin" aria-hidden /> {elapsed} s · Annuler
            </button>
          ) : (
            <button
              type="button"
              disabled={!facts?.length}
              onClick={() => void run()}
              className="ml-auto flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-40"
            >
              {result ? <RotateCcw className="size-3.5" aria-hidden /> : <ScrollText className="size-3.5" aria-hidden />}
              {result ? "Regénérer" : "Résumer la page"}
            </button>
          )}
        </div>
        {facts !== null && facts.length === 0 && <p className="mt-2 text-[11px] text-muted">Aucun visuel chiffré sur cette page.</p>}
        {error && (
          <p role="alert" className="mt-3 flex items-start gap-1.5 text-xs text-negative">
            <X className="mt-0.5 size-3 shrink-0" aria-hidden /> {error}
          </p>
        )}
      </Section>

      {result && (
        <Section title={`Synthèse · ${result.provider === "anthropic" ? "Claude" : "Ollama"}`}>
          <article aria-label="Synthèse de la page" className="space-y-2">
            <p className="text-sm font-semibold leading-snug">{result.headline}</p>
            <ul className="space-y-2">
              {result.points.map((p) => (
                <li key={p.text} className="text-xs leading-relaxed">
                  <p className="flex gap-1.5">
                    <span aria-hidden className="text-muted">
                      •
                    </span>
                    <span>{p.text}</span>
                  </p>
                  {p.visuals.length > 0 && (
                    <span className="mt-1 flex flex-wrap gap-1 pl-3">
                      {p.visuals.map((id) => (
                        <button
                          key={id}
                          type="button"
                          onClick={() => focusVisual(id)}
                          className="max-w-full truncate rounded border border-border px-1.5 py-0.5 text-[10px] text-muted hover:border-accent hover:text-accent"
                          title="Afficher le visuel"
                        >
                          {titleOf(id)}
                        </button>
                      ))}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </article>
          <p className="mt-3 flex items-start gap-1.5 text-[10px] text-muted">
            <BadgeCheck className="mt-px size-3 shrink-0 text-positive" aria-hidden />
            Chaque chiffre a été comparé aux chiffres de la page ; les phrases qui en citent d'autres sont écartées.
          </p>
          {result.warnings.length > 0 && (
            <details className="mt-2 text-[10px] text-muted">
              <summary className="cursor-pointer">{result.warnings.length} élément(s) écarté(s)</summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {result.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </details>
          )}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={insert}
              disabled={!editing}
              title={editing ? "Ajoute une zone de texte modifiable en haut de la page" : "Passez en mode Édition pour insérer"}
              className="flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-40"
            >
              <FileText className="size-3.5" aria-hidden /> Insérer dans la page
            </button>
            <button type="button" onClick={() => void copy()} className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs hover:bg-surface-2">
              <ClipboardCopy className="size-3.5" aria-hidden /> {copied ? "Copié" : "Copier"}
            </button>
          </div>
        </Section>
      )}
    </Pane>
  );
}
