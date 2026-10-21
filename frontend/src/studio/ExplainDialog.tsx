import { Lightbulb, Loader2, ShieldCheck, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";

import { useEngine } from "../components/ai/EnginePicker";
import { activeFilterTexts } from "../export/notes";
import { api } from "../lib/api";
import { amount } from "../summary/facts";
import type { Explanation } from "../summary/explainRun";
import { runExplain } from "../summary/explainRun";
import type { Scalar } from "../types/dataset";
import type { Page, Visual } from "../types/report";
import type { AnswerResponse } from "../types/summary";
import { numberFormat } from "../visuals/common";
import { bindingLabel } from "../visuals/fields";
import { formatDimension } from "../visuals/format";
import { defaultTitle } from "../visuals/title";
import type { Selection } from "../visuals/types";
import { useStudioData } from "./context";

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * « Expliquer cette valeur » : décomposition calculée par le moteur (contributeurs par dimension), puis
 * explication rédigée par l'IA à partir de ces seuls chiffres (vérifiés un à un côté serveur).
 */
export function ExplainDialog({ page, visual, selection, onClose }: { page: Page; visual: Visual; selection: Selection; onClose: () => void }) {
  const titleId = useId();
  const { profiles } = useStudioData();
  const engine = useEngine();
  const [result, setResult] = useState<Explanation | string | null>(null);
  const [text, setText] = useState<AnswerResponse | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [writing, setWriting] = useState(false);
  const profile = visual.dataset_id ? profiles.get(visual.dataset_id) : undefined;

  useEffect(() => {
    let alive = true;
    runExplain(page, visual, selection, profiles)
      .then((r) => alive && setResult(r))
      .catch((e: unknown) => alive && setResult(message(e)));
    return () => {
      alive = false;
    };
  }, [page, visual, selection, profiles]);

  const explanation = typeof result === "object" && result !== null ? result : null;
  const axisType = explanation ? profile?.columns.find((c) => c.name === explanation.target.axis.field)?.type : undefined;
  const label = (v: Scalar) => (explanation ? formatDimension(v, axisType, explanation.target.axis.bin ?? null) : "");

  // Rédaction par l'IA dès que les chiffres sont prêts (si un moteur répond).
  useEffect(() => {
    if (!explanation || engine.down || !explanation.facts.length) return;
    const ctrl = new AbortController();
    setWriting(true);
    setAiError(null);
    const active = activeFilterTexts(page, selection, profiles);
    api
      .answer(
        {
          kind: "explain",
          question: `Pourquoi « ${label(explanation.target.current)} » vaut-il ${amount(explanation.target.currentValue, numberFormat(visual, explanation.target.measure))} ?`.slice(0, 500),
          provider: engine.provider,
          filters: [...active.page, ...active.slicers].slice(0, 20),
          visuals: [{ id: visual.id, title: (visual.title || defaultTitle(visual)).slice(0, 200), type: visual.type, facts: explanation.facts }],
        },
        ctrl.signal,
      )
      .then(setText)
      .catch((e: unknown) => !ctrl.signal.aborted && setAiError(message(e)))
      .finally(() => setWriting(false));
    return () => ctrl.abort();
    // Une rédaction par explication calculée (le reste ne change pas pendant la boîte).
  }, [explanation, engine.down]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const fmt = explanation ? numberFormat(visual, explanation.target.measure) : {};
  const t = explanation?.target;
  const delta = t && t.previousValue !== null ? t.currentValue - t.previousValue : null;

  return createPortal(
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="atelier-pop flex max-h-[88vh] w-full max-w-xl flex-col rounded-xl border border-border bg-surface text-fg shadow-2xl">
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Lightbulb className="size-4 text-accent-ink" aria-hidden />
          <h2 id={titleId} className="flex-1 truncate text-sm font-semibold">
            {t ? `Pourquoi « ${label(t.current)} » ?` : "Expliquer cette valeur"}
          </h2>
          <button type="button" onClick={onClose} aria-label="Fermer" className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg">
            <X className="size-4" aria-hidden />
          </button>
        </header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 text-xs">
          {result === null && (
            <p className="flex items-center gap-1.5 text-muted">
              <Loader2 className="size-3.5 animate-spin" aria-hidden /> Décomposition en cours…
            </p>
          )}
          {typeof result === "string" && <p className="text-muted">{result}</p>}
          {explanation && t && (
            <>
              <p>
                <span className="font-medium">{bindingLabel(t.measure)}</span> : {amount(t.currentValue, fmt)}
                {t.mode === "previous" && t.previousValue !== null && delta !== null ? (
                  <>
                    {" "}
                    contre {amount(t.previousValue, fmt)} pour {label(t.previous)}, soit{" "}
                    <strong className={delta >= 0 ? "text-positive" : "text-negative"}>
                      {delta > 0 ? "+" : ""}
                      {amount(delta, fmt)}
                    </strong>
                    .
                  </>
                ) : (
                  <span className="text-muted"> — répartition comparée à l'ensemble.</span>
                )}
              </p>

              <section aria-label="Explication" className="rounded-lg border border-border bg-bg p-3">
                {engine.down ? (
                  <p className="text-muted">{engine.label} n'est pas disponible : voici la décomposition chiffrée.</p>
                ) : writing ? (
                  <p className="flex items-center gap-1.5 text-muted">
                    <Loader2 className="size-3.5 animate-spin" aria-hidden /> {engine.label} rédige l'explication…
                  </p>
                ) : text ? (
                  <>
                    <p className="leading-relaxed">{text.answer}</p>
                    <p className="mt-1.5 flex items-center gap-1 text-[11px] text-muted">
                      <ShieldCheck className="size-3 text-positive" aria-hidden /> Chaque chiffre vérifié contre la décomposition ci-dessous · {engine.label}
                    </p>
                  </>
                ) : aiError ? (
                  <p className="text-muted">Explication rédigée indisponible ({aiError}).</p>
                ) : null}
              </section>

              {explanation.dimensions.map((d) => {
                const max = Math.max(...d.items.map((i) => Math.abs(i.delta)), 1e-9);
                return (
                  <section key={d.dimension} aria-label={`Contributions par ${d.dimension}`}>
                    <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
                      Par {d.dimension} {t.mode === "previous" ? "· contribution à l'écart" : "· écart de part (points)"}
                    </h3>
                    <ul className="space-y-1">
                      {d.items.map((i) => (
                        <li key={i.key} className="grid grid-cols-[8rem_minmax(0,1fr)_5.5rem] items-center gap-2">
                          <span className="truncate" title={i.key}>
                            {i.key}
                          </span>
                          <span className="h-2 rounded-full bg-surface-2">
                            <span className={`block h-2 rounded-full ${i.delta >= 0 ? "bg-positive" : "bg-negative"}`} style={{ width: `${Math.max(3, (Math.abs(i.delta) / max) * 100)}%` }} />
                          </span>
                          <span className="text-right tabular-nums">
                            {i.delta > 0 ? "+" : ""}
                            {t.mode === "previous" ? amount(i.delta, fmt) : `${(Math.round(i.delta * 10) / 10).toLocaleString("fr-FR")} pts`}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
              <p className="text-[11px] text-muted">
                Décomposition calculée sur cet ordinateur avec les filtres actifs ({explanation.dimensions.length ? `${explanation.dimensions.length} dimension(s) retenue(s) sur celles du jeu` : "aucune dimension"}). L'IA ne reçoit que ces chiffres agrégés.
              </p>
            </>
          )}
        </div>
      </div>
    </div>,
    document.fullscreenElement ?? document.body,
  );
}
