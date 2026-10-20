import clsx from "clsx";
import { Check, ChevronRight, History, Lightbulb, Loader2, Plus, RotateCcw, SquarePen, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { api } from "../../lib/api";
import type { ProposedVisual } from "../../types/builder";
import type { DatasetProfile } from "../../types/dataset";
import { aiCatalog } from "../../visuals/catalog";
import { bindingLabel } from "../../visuals/fields";
import { VISUALS } from "../../visuals/registry";
import { defaultTitle } from "../../visuals/title";
import {
  type BuildEntry,
  type BuilderSession,
  type Placement,
  addableIndexes,
  createdByIndex,
  currentEntry,
  entryId,
  mapRepaired,
  newRequest,
  placedCount,
  placement,
  previousEntries,
  recordAdded,
  recordResult,
  showEntry,
  useAIBuilder,
  useBuilderSession,
  visualIds,
} from "../aiBuilder";
import { useStudioData } from "../context";
import { useStudio } from "../store";
import { EnginePicker, useEngine } from "../../components/ai/EnginePicker";
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

// Générations en cours, par rapport : le volet peut être fermé et rouvert pendant l'attente.
const controllers = new Map<string, AbortController>();

const engineName = (p: string) => (p === "anthropic" ? "Claude" : "Ollama");
const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? "s" : ""}`;
const clock = (at: number) => new Date(at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

/**
 * Volet « Créer avec l'IA » : une phrase → des visuels validés, à ajouter à la page.
 *
 * Disposition : moteur, puis la demande (avec ses suggestions juste dessous, repliées dès qu'un
 * résultat est affiché), le résultat courant, et les demandes précédentes de la session.
 * Les suggestions restent ainsi à côté de la zone qu'elles remplissent, sans repousser le résultat.
 */
export function AIBuilderPane() {
  const { activeDatasetId, profiles } = useStudioData();
  const report = useStudio((s) => s.report);
  const pageId = useStudio((s) => s.pageId);
  const reportId = report?.id;
  const session = useBuilderSession(reportId);
  const engine = useEngine();
  const [elapsed, setElapsed] = useState(0);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const profile = activeDatasetId ? profiles.get(activeDatasetId) : undefined;
  const suggestions = useMemo(() => suggestPrompts(profile), [profile]);
  const page = report?.pages.find((p) => p.id === pageId);
  const ids = useMemo(() => visualIds(report), [report]);
  const current = currentEntry(session);
  const previous = previousEntries(session);
  const pending = session.pending;
  const [suggestOpen, setSuggestOpen] = useState(!current);
  const [historyOpen, setHistoryOpen] = useState(false);

  const update = (fn: (s: BuilderSession) => BuilderSession) => {
    if (reportId) useAIBuilder.getState().update(reportId, fn);
  };

  // Suggestions ouvertes quand aucun résultat n'est affiché, repliées dès qu'il y en a un.
  const currentId = current?.id ?? null;
  useEffect(() => setSuggestOpen(!currentId), [currentId]);

  useEffect(() => {
    if (!pending) return;
    const tick = () => setElapsed(Math.round((Date.now() - pending.startedAt) / 1000));
    tick();
    const t = setInterval(tick, 500);
    return () => clearInterval(t);
  }, [pending]);

  const generate = async (text = session.draft) => {
    const prompt = text.trim();
    if (!reportId || !activeDatasetId || !prompt || pending) return;
    const id = reportId;
    const datasetId = activeDatasetId;
    const set = (fn: (s: BuilderSession) => BuilderSession) => useAIBuilder.getState().update(id, fn);
    set((s) => ({ ...s, draft: text, pending: { prompt, startedAt: Date.now() }, error: null }));
    setNotice(null);
    const ctrl = new AbortController();
    controllers.set(id, ctrl);
    try {
      const result = await api.buildVisuals(
        {
          prompt,
          dataset_id: datasetId,
          provider: engine.provider,
          catalog: aiCatalog(),
          max_visuals: session.count,
          existing: page?.visuals.map((v) => v.title || defaultTitle(v)).slice(0, 40) ?? [],
        },
        ctrl.signal,
      );
      set((s) => recordResult(s, { id: entryId(), prompt, at: Date.now(), datasetId, result, added: {} }));
    } catch (err) {
      const aborted = (err as Error).name === "AbortError";
      set((s) => ({ ...s, pending: null, error: aborted ? null : err instanceof Error ? err.message : String(err) }));
    } finally {
      controllers.delete(id);
    }
  };

  /** Ajoute des propositions d'une entrée (courante ou passée) : toujours revalidées par `repair`. */
  const add = async (entry: BuildEntry, indexes: number[]) => {
    if (!reportId || !indexes.length || adding) return;
    setAdding(true);
    setNotice(null);
    try {
      const specs = indexes.map((i) => entry.result.visuals[i]).filter((v): v is ProposedVisual => !!v);
      const res = await api.repairVisuals({ dataset_id: entry.datasetId, catalog: aiCatalog(), visuals: specs });
      const repaired = mapRepaired(indexes, res);
      const created = useStudio.getState().addGenerated(repaired.specs, entry.datasetId);
      update((s) => recordAdded(s, entry.id, createdByIndex(repaired.indexes, created)));
      if (repaired.dropped.length) {
        const titles = repaired.dropped.map((d) => `« ${entry.result.visuals[d.index]?.title ?? "visuel"} » (${d.reason})`);
        setNotice(`Non ajouté, les données ont changé : ${titles.join(", ")}`);
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setAdding(false);
    }
  };

  const canReset = !pending && (!!session.draft || !!current || !!session.error);

  return (
    <Pane title="Créer avec l'IA" width="w-80">
      <Section title="Moteur">
        <EnginePicker
          engine={engine}
          note={`Seuls les noms de colonnes, leurs statistiques et 5 lignes d'exemple de « ${profile?.name ?? "…"} » sont envoyés.`}
        />
      </Section>

      <Section
        title="Votre demande"
        action={
          canReset ? (
            <button
              type="button"
              onClick={() => {
                update(newRequest);
                setNotice(null);
              }}
              className="flex items-center gap-1 text-[11px] font-medium text-accent hover:underline"
            >
              <SquarePen className="size-3" aria-hidden /> Nouvelle demande
            </button>
          ) : null
        }
      >
        <textarea
          value={session.draft}
          onChange={(e) => {
            const draft = e.target.value;
            update((s) => ({ ...s, draft }));
          }}
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
            <select
              value={session.count}
              onChange={(e) => {
                const count = Number(e.target.value);
                update((s) => ({ ...s, count }));
              }}
              className="rounded border border-border bg-bg px-1 py-0.5 text-xs text-fg"
            >
              {[1, 2, 3, 4, 6].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            visuel{session.count > 1 ? "s" : ""}
          </label>
          {pending ? (
            <button
              type="button"
              onClick={() => reportId && controllers.get(reportId)?.abort()}
              className="ml-auto flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs"
            >
              <Loader2 className="size-3.5 animate-spin" aria-hidden /> {elapsed} s · Annuler
            </button>
          ) : (
            <button
              type="button"
              disabled={!session.draft.trim() || !activeDatasetId}
              onClick={() => void generate()}
              className="ml-auto flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-40"
            >
              <Sparkles className="size-3.5" aria-hidden /> Générer
            </button>
          )}
        </div>
        {suggestions.length > 0 && (
          <div className="mt-3">
            <Disclosure open={suggestOpen} onToggle={() => setSuggestOpen((o) => !o)} icon={Lightbulb} label={`Suggestions (${suggestions.length})`} />
            {suggestOpen && (
              <div className="mt-1.5 flex flex-col gap-1">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    disabled={!!pending}
                    onClick={() => void generate(s)}
                    className="rounded-md border border-border px-2 py-1.5 text-left text-xs hover:bg-surface-2 disabled:opacity-50"
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        {session.error && (
          <p role="alert" className="mt-3 flex items-start gap-1.5 text-xs text-negative">
            <X className="mt-0.5 size-3 shrink-0" aria-hidden /> {session.error}
          </p>
        )}
        {notice && (
          <p role="status" className="mt-3 text-xs text-negative">
            {notice}
          </p>
        )}
      </Section>

      {current && (
        <Section
          title={`${plural(current.result.visuals.length, "proposition")} · ${engineName(current.result.provider)}`}
          action={
            current.result.visuals.length > 1 && addableIndexes(current, ids).length > 0 ? (
              <button
                type="button"
                disabled={adding}
                onClick={() => void add(current, addableIndexes(current, ids))}
                className="text-[11px] font-medium text-accent hover:underline disabled:opacity-50"
              >
                Tout ajouter
              </button>
            ) : null
          }
        >
          {current.result.explanation && <p className="mb-3 text-xs leading-relaxed text-muted">{current.result.explanation}</p>}
          <ul className="space-y-2">
            {current.result.visuals.map((v, i) => (
              <ProposalCard key={i} visual={v} state={placement(current, i, ids)} disabled={adding} onAdd={() => void add(current, [i])} />
            ))}
          </ul>
          {current.result.warnings.length > 0 && (
            <details className="mt-3 text-[10px] text-muted">
              <summary className="cursor-pointer">{current.result.warnings.length} correction(s) appliquée(s) automatiquement</summary>
              <ul className="mt-1 list-disc space-y-0.5 pl-4">
                {current.result.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </details>
          )}
          <p className="mt-3 text-[10px] text-muted">Ctrl+Z annule l'ajout. Les visuels restent modifiables comme les autres.</p>
        </Section>
      )}

      {previous.length > 0 && (
        <section className="border-b border-border px-3 py-3">
          <Disclosure open={historyOpen} onToggle={() => setHistoryOpen((o) => !o)} icon={History} label={`Demandes précédentes (${previous.length})`} />
          {historyOpen && (
            <ul className="mt-2 space-y-1.5">
              {previous.map((entry) => (
                <HistoryItem
                  key={entry.id}
                  entry={entry}
                  ids={ids}
                  disabled={adding || !!pending}
                  onAdd={(indexes) => void add(entry, indexes)}
                  onShow={() => update((s) => showEntry(s, entry.id))}
                />
              ))}
            </ul>
          )}
        </section>
      )}
    </Pane>
  );
}

/** En-tête repliable (bouton + chevron), accessible au clavier. */
function Disclosure({ open, onToggle, icon: Icon, label }: { open: boolean; onToggle: () => void; icon: typeof History; label: string }) {
  return (
    <button type="button" aria-expanded={open} onClick={onToggle} className="flex w-full items-center gap-1.5 text-[11px] font-semibold text-muted hover:text-fg">
      <ChevronRight className={clsx("size-3 transition-transform", open && "rotate-90")} aria-hidden />
      <Icon className="size-3" aria-hidden />
      {label}
    </button>
  );
}

/** Carte d'une proposition : type, titre, champs par rôle, bouton Ajouter / Ajouté / Ajouter de nouveau. */
function ProposalCard({ visual, state, disabled, onAdd }: { visual: ProposedVisual; state: Placement; disabled: boolean; onAdd: () => void }) {
  const def = VISUALS[visual.type];
  const placed = state === "placed";
  const title = visual.title ?? def.label;
  return (
    <li className="rounded-md border border-border p-2.5">
      <div className="flex items-start gap-2">
        <def.icon className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium" title={title}>
            {title}
          </p>
          <p className="text-[10px] text-muted">{def.label}</p>
        </div>
        <button
          type="button"
          disabled={placed || disabled}
          onClick={onAdd}
          aria-label={placed ? `${title} : ajouté` : `Ajouter ${title}${state === "removed" ? " de nouveau" : ""}`}
          title={state === "removed" ? "Retiré de la page (Ctrl+Z ou suppression) : l'ajouter de nouveau" : undefined}
          className={clsx(
            "flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px] font-medium",
            placed ? "text-positive" : "bg-accent text-accent-fg hover:brightness-110 disabled:opacity-50",
          )}
        >
          {placed ? <Check className="size-3" aria-hidden /> : state === "removed" ? <RotateCcw className="size-3" aria-hidden /> : <Plus className="size-3" aria-hidden />}
          {placed ? "Ajouté" : state === "removed" ? "Réajouter" : "Ajouter"}
        </button>
      </div>
      <dl className="mt-2 space-y-0.5 text-[10px]">
        {def.roles
          .filter((r) => visual.roles[r.id]?.length)
          .map((r) => (
            <div key={r.id} className="flex gap-1.5">
              <dt className="shrink-0 text-muted">{r.label} :</dt>
              <dd className="truncate">{visual.roles[r.id]?.map(bindingLabel).join(", ")}</dd>
            </div>
          ))}
      </dl>
    </li>
  );
}

/** Demande passée : repliée sur une ligne (texte, heure, moteur), dépliée avec ses propositions. */
function HistoryItem({
  entry,
  ids,
  disabled,
  onAdd,
  onShow,
}: {
  entry: BuildEntry;
  ids: Set<string>;
  disabled: boolean;
  onAdd: (indexes: number[]) => void;
  onShow: () => void;
}) {
  const [open, setOpen] = useState(false);
  const n = entry.result.visuals.length;
  const placed = placedCount(entry, ids);
  const addable = addableIndexes(entry, ids);
  return (
    <li className="rounded-md border border-border">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="flex w-full items-start gap-1.5 px-2 py-1.5 text-left hover:bg-surface-2">
        <ChevronRight className={clsx("mt-0.5 size-3 shrink-0 text-muted transition-transform", open && "rotate-90")} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 text-xs">{entry.prompt}</span>
          <span className="block text-[10px] text-muted">
            {clock(entry.at)} · {plural(n, "proposition")} · {engineName(entry.result.provider)}
            {placed > 0 ? ` · ${placed} sur la page` : ""}
          </span>
        </span>
      </button>
      {open && (
        <div className="border-t border-border p-2">
          <ul className="space-y-2">
            {entry.result.visuals.map((v, i) => (
              <ProposalCard key={i} visual={v} state={placement(entry, i, ids)} disabled={disabled} onAdd={() => onAdd([i])} />
            ))}
          </ul>
          <div className="mt-2 flex items-center gap-3 text-[11px] font-medium">
            <button type="button" onClick={onShow} className="text-accent hover:underline">
              Afficher en résultat
            </button>
            {n > 1 && addable.length > 0 && (
              <button type="button" disabled={disabled} onClick={() => onAdd(addable)} className="text-accent hover:underline disabled:opacity-50">
                Tout ajouter
              </button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}
