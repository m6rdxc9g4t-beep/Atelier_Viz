import clsx from "clsx";
import { Check, Loader2, Plus, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { api } from "../../lib/api";
import type { BuildResponse, ProposedVisual } from "../../types/builder";
import type { DatasetProfile } from "../../types/dataset";
import { aiCatalog } from "../../visuals/catalog";
import { bindingLabel } from "../../visuals/fields";
import { VISUALS } from "../../visuals/registry";
import { useStudioData } from "../context";
import { useStudio } from "../store";
import { defaultTitle } from "../../visuals/title";
import { EnginePicker, useEngine } from "./EnginePicker";
import { Pane, Section } from "./Pane";

/** Suggestions de demandes adaptées aux colonnes du jeu de données. */
export function suggestPrompts(profile: DatasetProfile | undefined): string[] {
  if (!profile) return [];
  const nums = profile.columns.filter((c) => c.type === "number" && !/^(id|code|lat|lon|lng)/i.test(c.name));
  const main = nums.find((c) => /ca|chiffre|montant|vente|revenu|total|amount|sales/i.test(c.name)) ?? nums[0];
  const date = profile.columns.find((c) => c.type === "date");
  const cats = profile.columns.filter((c) => c.type === "string" && c.distinct >= 2 && c.distinct <= 60).sort((a, b) => a.distinct - b.distinct);
  const geo = profile.columns.find((c) => c.type === "string" && /region|departement|dept|pays|country/i.test(c.name));
  const out: string[] = [];
  if (main && geo) out.push(`${main.name} par ${geo.name} sur une carte`);
  if (main && date) out.push(`Évolution mensuelle de ${main.name}${cats[0] ? ` par ${cats[0].name}` : ""}`);
  const top = cats.find((c) => c !== geo) ?? cats[0];
  if (main && top) out.push(`Top 5 des ${top.name} par ${main.name}`);
  if (cats.length >= 2 && main) out.push(`Tableau croisé ${cats[0]?.name} × ${cats[1]?.name}`);
  out.push("Tableau de bord de synthèse avec les indicateurs clés");
  return out.slice(0, 4);
}

/** Volet « Créer avec l'IA » : une phrase → des visuels validés, à ajouter à la page. */
export function AIBuilderPane() {
  const { activeDatasetId, profiles } = useStudioData();
  const report = useStudio((s) => s.report);
  const pageId = useStudio((s) => s.pageId);
  const engine = useEngine();
  const [prompt, setPrompt] = useState("");
  const [count, setCount] = useState(3);
  const [pending, setPending] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<BuildResponse | null>(null);
  const [added, setAdded] = useState<Set<number>>(new Set());
  const abort = useRef<AbortController | null>(null);
  const profile = activeDatasetId ? profiles.get(activeDatasetId) : undefined;
  const suggestions = useMemo(() => suggestPrompts(profile), [profile]);
  const page = report?.pages.find((p) => p.id === pageId);

  const provider = engine.provider;

  useEffect(() => {
    if (!pending) return;
    const started = Date.now();
    const t = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 500);
    return () => clearInterval(t);
  }, [pending]);

  const generate = async (text = prompt) => {
    if (!activeDatasetId || !text.trim() || pending) return;
    setPrompt(text);
    setPending(true);
    setElapsed(0);
    setError(null);
    setResult(null);
    setAdded(new Set());
    abort.current = new AbortController();
    try {
      const res = await api.buildVisuals(
        {
          prompt: text.trim(),
          dataset_id: activeDatasetId,
          provider,
          catalog: aiCatalog(),
          max_visuals: count,
          existing: page?.visuals.map((v) => v.title || defaultTitle(v)).slice(0, 40) ?? [],
        },
        abort.current.signal,
      );
      setResult(res);
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  const add = (indexes: number[]) => {
    if (!result || !activeDatasetId) return;
    const todo = indexes.filter((i) => !added.has(i));
    const specs = todo.map((i) => result.visuals[i]).filter((v): v is ProposedVisual => !!v);
    useStudio.getState().addGenerated(specs, activeDatasetId);
    setAdded((s) => new Set([...s, ...todo]));
  };

  return (
    <Pane title="Créer avec l'IA" width="w-80">
      <Section title="Moteur">
        <EnginePicker
          engine={engine}
          note={`Seuls les noms de colonnes, leurs statistiques et 5 lignes d'exemple de « ${profile?.name ?? "…"} » sont envoyés.`}
        />
      </Section>

      <Section title="Votre demande">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void generate();
          }}
          rows={3}
          placeholder="Ex. : chiffre d'affaires par région sur une carte"
          aria-label="Décrivez le visuel à créer"
          className="w-full resize-none rounded-md border border-border bg-bg px-2.5 py-2 text-sm outline-none focus:border-accent"
        />
        <div className="mt-2 flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-muted">
            Jusqu'à
            <select value={count} onChange={(e) => setCount(Number(e.target.value))} className="rounded border border-border bg-bg px-1 py-0.5 text-xs text-fg">
              {[1, 2, 3, 4, 6].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            visuel{count > 1 ? "s" : ""}
          </label>
          {pending ? (
            <button type="button" onClick={() => abort.current?.abort()} className="ml-auto flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs">
              <Loader2 className="size-3.5 animate-spin" aria-hidden /> {elapsed} s · Annuler
            </button>
          ) : (
            <button
              type="button"
              disabled={!prompt.trim() || !activeDatasetId}
              onClick={() => void generate()}
              className="ml-auto flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-40"
            >
              <Sparkles className="size-3.5" aria-hidden /> Générer
            </button>
          )}
        </div>
        {!result && !pending && suggestions.length > 0 && (
          <div className="mt-3 flex flex-col gap-1">
            <p className="text-[10px] uppercase tracking-wide text-muted">Suggestions</p>
            {suggestions.map((s) => (
              <button key={s} type="button" onClick={() => void generate(s)} className="rounded-md border border-border px-2 py-1.5 text-left text-xs hover:bg-surface-2">
                {s}
              </button>
            ))}
          </div>
        )}
        {error && (
          <p role="alert" className="mt-3 flex items-start gap-1.5 text-xs text-negative">
            <X className="mt-0.5 size-3 shrink-0" aria-hidden /> {error}
          </p>
        )}
      </Section>

      {result && (
        <Section
          title={`${result.visuals.length} proposition${result.visuals.length > 1 ? "s" : ""} · ${result.provider === "anthropic" ? "Claude" : "Ollama"}`}
          action={
            result.visuals.length > 1 && added.size < result.visuals.length ? (
              <button type="button" onClick={() => add(result.visuals.map((_, i) => i))} className="text-[11px] font-medium text-accent hover:underline">
                Tout ajouter
              </button>
            ) : null
          }
        >
          {result.explanation && <p className="mb-3 text-xs leading-relaxed text-muted">{result.explanation}</p>}
          <ul className="space-y-2">
            {result.visuals.map((v, i) => {
              const def = VISUALS[v.type];
              const done = added.has(i);
              return (
                <li key={i} className="rounded-md border border-border p-2.5">
                  <div className="flex items-start gap-2">
                    <def.icon className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium">{v.title ?? def.label}</p>
                      <p className="text-[10px] text-muted">{def.label}</p>
                    </div>
                    <button
                      type="button"
                      disabled={done}
                      onClick={() => add([i])}
                      className={clsx(
                        "flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px] font-medium",
                        done ? "text-positive" : "bg-accent text-accent-fg hover:brightness-110",
                      )}
                    >
                      {done ? <Check className="size-3" aria-hidden /> : <Plus className="size-3" aria-hidden />}
                      {done ? "Ajouté" : "Ajouter"}
                    </button>
                  </div>
                  <dl className="mt-2 space-y-0.5 text-[10px]">
                    {def.roles
                      .filter((r) => v.roles[r.id]?.length)
                      .map((r) => (
                        <div key={r.id} className="flex gap-1.5">
                          <dt className="shrink-0 text-muted">{r.label} :</dt>
                          <dd className="truncate">{v.roles[r.id]?.map(bindingLabel).join(", ")}</dd>
                        </div>
                      ))}
                  </dl>
                </li>
              );
            })}
          </ul>
          {result.warnings.length > 0 && (
            <details className="mt-3 text-[10px] text-muted">
              <summary className="cursor-pointer">{result.warnings.length} correction(s) appliquée(s) automatiquement</summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {result.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </details>
          )}
          <p className="mt-3 text-[10px] text-muted">Ctrl+Z annule l'ajout. Les visuels restent modifiables comme les autres.</p>
        </Section>
      )}
    </Pane>
  );
}
