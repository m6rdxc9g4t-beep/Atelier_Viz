import { BadgeCheck, Calculator, ClipboardCopy, FileText, Loader2, RotateCcw, ScrollText, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api } from "../../lib/api";
import { type PageBrief, loadPageBrief, summaryRequest, summaryText } from "../../summary/pageSummary";
import type { SummaryResponse } from "../../types/summary";
import { useStudioData } from "../context";
import { useStudio } from "../store";
import { EnginePicker, useEngine } from "../../components/ai/EnginePicker";
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
  const [brief, setBrief] = useState<PageBrief | null>(null);
  const [pending, setPending] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SummaryResponse | null>(null);
  const [copied, setCopied] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const page = report?.pages.find((p) => p.id === pageId);

  // Faits et lecture calculée, refaits quand la page, ses filtres ou la sélection changent (aucun appel à l'IA).
  useEffect(() => {
    if (!page) return;
    let alive = true;
    setBrief(null);
    loadPageBrief(page, selection, profiles)
      .then((b) => alive && setBrief(b))
      .catch(() => alive && setBrief({ visuals: [], reading: null }));
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
  const facts = brief?.visuals ?? null;
  const reading = brief?.reading ?? null;
  const count = (facts?.reduce((t, v) => t + v.facts.length, 0) ?? 0) + (reading?.points.length ?? 0);
  const titleOf = (id: string) => facts?.find((v) => v.id === id)?.title ?? "visuel";

  const run = async () => {
    if (!brief?.visuals.length || pending) return;
    setPending(true);
    setElapsed(0);
    setError(null);
    setResult(null);
    abort.current = new AbortController();
    try {
      setResult(await api.summarizePage(summaryRequest(report.name, page, selection, profiles, brief, engine.provider, points), abort.current.signal));
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
    // Hauteur (px) : une ligne de 20 px par point (+ ouverture), et deux lignes de marge pour les retours à la ligne.
    const height = (3 + result.points.length) * 20 + 32;
    const id = useStudio.getState().insertTextAtTop(summaryText(result), height);
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
              : `Seuls ${count} constats chiffrés de ${facts.length} visuel${facts.length > 1 ? "s" : ""} sont envoyés, aucune ligne de données.`
          }
        />
        {facts && facts.length > 0 && (
          <details className="mt-2 text-[11px] text-muted">
            <summary className="cursor-pointer hover:text-fg">Voir les chiffres envoyés</summary>
            <ul className="mt-1.5 space-y-1.5">
              {reading && (
                <li>
                  <p className="font-medium text-fg">Lecture calculée de la page</p>
                  <ul className="list-disc pl-4">
                    {reading.points.map((p) => (
                      <li key={p.text}>{p.text}</li>
                    ))}
                  </ul>
                </li>
              )}
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
            <select value={points} onChange={(e) => setPoints(Number(e.target.value))} className="rounded border border-border bg-field px-1 py-0.5 text-xs text-fg">
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
              className="atelier-btn-primary ml-auto flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-40"
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
        <Section title={result.local ? "Synthèse · calculée sans IA" : `Synthèse · ${result.provider === "anthropic" ? "Claude" : "Ollama"}`}>
          {result.local && result.warnings[0] && (
            <p role="status" className="mb-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-warn">
              <Calculator className="mt-0.5 size-3 shrink-0" aria-hidden /> {result.warnings[0]}
            </p>
          )}
          <article aria-label="Synthèse de la page" className="space-y-2">
            <p className="text-[13px] font-medium leading-snug">{result.headline}</p>
            <ul className="space-y-2">
              {result.points.map((p) => (
                <li key={p.text} className="text-xs leading-relaxed">
                  <p className="flex gap-1.5">
                    <span aria-hidden className="text-muted">
                      •
                    </span>
                    <span>{p.text}</span>
                  </p>
                  {(p.visuals.length > 0 || (p.local && !result.local)) && (
                    <span className="mt-1 flex flex-wrap items-center gap-1 pl-3">
                      {p.visuals.map((id) => (
                        <button
                          key={id}
                          type="button"
                          onClick={() => focusVisual(id)}
                          className="max-w-full truncate rounded border border-border px-1.5 py-0.5 text-[10px] text-muted hover:bg-surface-2 hover:text-fg"
                          title="Afficher le visuel"
                        >
                          {titleOf(id)}
                        </button>
                      ))}
                      {p.local && !result.local && (
                        <span className="text-[10px] text-faint" title="Constat calculé sur cette machine, à la place d'une phrase écartée">
                          calculé sans IA
                        </span>
                      )}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </article>
          <p className="mt-3 flex items-start gap-1.5 text-[10px] text-muted">
            <BadgeCheck className="mt-px size-3 shrink-0 text-positive" aria-hidden />
            {result.local
              ? "Lecture calculée sur cette machine à partir des chiffres de la page : aucune phrase ne vient d'une IA."
              : "Chaque chiffre a été comparé aux chiffres de la page ; les phrases qui en citent d'autres, ou qui recopient une carte, sont écartées."}
          </p>
          {result.warnings.length > (result.local ? 1 : 0) && (
            <details className="mt-2 text-[10px] text-muted">
              <summary className="cursor-pointer">{result.local ? "Détail" : `${result.warnings.length} élément(s) écarté(s)`}</summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {(result.local ? result.warnings.slice(1) : result.warnings).map((w) => (
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
              className="atelier-btn-primary flex items-center gap-1.5 rounded-md bg-accent px-2.5 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-40"
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
