import clsx from "clsx";
import { Calculator, Check, Loader2, SquareFunction, Trash2, TriangleAlert, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { datasetChanged, setProfile } from "../hooks/useDatasetProfiles";
import { api } from "../lib/api";
import type { DatasetModel, DatasetProfile, ExpressionResult, ModelIssue } from "../types/dataset";
import { formatDimension, formatNumber } from "../visuals/format";
import { useStudio } from "./store";

export type ModelItemKind = "column" | "measure";

/** Fonctions proposées (miroir de `CATALOG` dans backend/app/services/engine/expressions.py). */
const FUNCTIONS: { name: string; syntax: string; kinds: ModelItemKind[] }[] = [
  { name: "SUM", syntax: "SUM()", kinds: ["measure"] },
  { name: "AVG", syntax: "AVG()", kinds: ["measure"] },
  { name: "COUNT", syntax: "COUNT(*)", kinds: ["measure"] },
  { name: "COUNT_DISTINCT", syntax: "COUNT_DISTINCT()", kinds: ["measure"] },
  { name: "MIN", syntax: "MIN()", kinds: ["measure"] },
  { name: "MAX", syntax: "MAX()", kinds: ["measure"] },
  { name: "MEDIAN", syntax: "MEDIAN()", kinds: ["measure"] },
  { name: "DIVIDE", syntax: "DIVIDE(, )", kinds: ["measure", "column"] },
  { name: "IF", syntax: "IF(, , )", kinds: ["measure", "column"] },
  { name: "ROUND", syntax: "ROUND(, 2)", kinds: ["measure", "column"] },
  { name: "ABS", syntax: "ABS()", kinds: ["measure", "column"] },
  { name: "COALESCE", syntax: "COALESCE(, 0)", kinds: ["measure", "column"] },
  { name: "YEAR", syntax: "YEAR()", kinds: ["column"] },
  { name: "MONTH", syntax: "MONTH()", kinds: ["column"] },
  { name: "CONCAT", syntax: "CONCAT(, )", kinds: ["column"] },
];

const EXAMPLES: Record<ModelItemKind, string> = {
  measure: "ex. SUM(chiffre_affaires) - SUM(cout)  ·  DIVIDE([marge], SUM(chiffre_affaires))",
  column: "ex. prix_unitaire * 1.2  ·  IF(quantite >= 10, \"Gros\", \"Petit\")",
};

/** Nom à insérer dans une expression : brut s'il est simple, sinon entre crochets. */
export function fieldRef(name: string): string {
  return /^[\p{L}_][\p{L}\p{N}_]*$/u.test(name) ? name : `[${name}]`;
}

/** Remplace (ou ajoute, ou supprime avec `next = null`) un élément du modèle. */
export function updateModel(model: DatasetModel, kind: ModelItemKind, previous: string | null, next: { name: string; expression: string } | null): DatasetModel {
  const key = kind === "column" ? "columns" : "measures";
  const list = [...model[key]];
  const index = previous === null ? -1 : list.findIndex((x) => x.name === previous);
  if (next === null) {
    if (index >= 0) list.splice(index, 1);
  } else if (index >= 0) {
    list[index] = { ...list[index], ...next };
  } else {
    list.push(next);
  }
  return { ...model, [key]: list };
}

interface Props {
  profile: DatasetProfile;
  kind: ModelItemKind;
  /** Élément modifié ; absent = création. */
  initial?: { name: string; expression: string };
  onClose: () => void;
}

/** Éditeur d'une colonne ou d'une mesure calculée : vérification à la frappe, aperçu, enregistrement. */
export function ModelEditor({ profile, kind, initial, onClose }: Props) {
  const [name, setName] = useState(initial?.name ?? "");
  const [expression, setExpression] = useState(initial?.expression ?? "");
  const [check, setCheck] = useState<ExpressionResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const report = useStudio((s) => s.report);
  const model: DatasetModel = profile.model ?? { columns: [], measures: [] };
  const Icon = kind === "measure" ? Calculator : SquareFunction;

  // Vérification à la frappe (300 ms après la dernière touche).
  useEffect(() => {
    if (!expression.trim()) {
      setCheck(null);
      return;
    }
    const ctrl = new AbortController();
    setChecking(true);
    const t = setTimeout(() => {
      api.datasets
        .checkExpression(profile.id, { kind, name: initial?.name ?? name, expression }, ctrl.signal)
        .then(setCheck)
        .catch((e: unknown) => (e as Error).name !== "AbortError" && setCheck({ ok: false, error: (e as Error).message, preview: [] }))
        .finally(() => setChecking(false));
    }, 300);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [expression, kind, profile.id, initial?.name, name]);

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

  const fields = useMemo(() => {
    const cols = profile.columns.filter((c) => c.name !== initial?.name).map((c) => ({ name: c.name, measure: false }));
    const measures = kind === "measure" ? model.measures.filter((m) => m.name !== initial?.name).map((m) => ({ name: m.name, measure: true })) : [];
    return [...cols, ...measures];
  }, [profile, model, kind, initial?.name]);

  // Visuels du rapport ouvert qui utilisent cet élément (renommage, suppression).
  const usages = useMemo(() => {
    if (!initial || !report) return 0;
    return report.pages
      .flatMap((p) => p.visuals)
      .filter((v) => v.dataset_id === profile.id && Object.values(v.roles).flat().some((b) => b.field === initial.name && (kind === "measure") === (b.agg === "calc"))).length;
  }, [report, initial, profile.id, kind]);

  const insert = (text: string, caretBack = 0) => {
    const el = area.current;
    const start = el?.selectionStart ?? expression.length;
    const end = el?.selectionEnd ?? expression.length;
    const next = expression.slice(0, start) + text + expression.slice(end);
    setExpression(next);
    requestAnimationFrame(() => {
      el?.focus();
      const pos = start + text.length - caretBack;
      el?.setSelectionRange(pos, pos);
    });
  };

  const save = async (remove = false) => {
    setSaving(true);
    setError(null);
    try {
      const next = updateModel(model, kind, initial?.name ?? null, remove ? null : { name: name.trim(), expression });
      const updated = await api.datasets.saveModel(profile.id, next);
      setProfile(updated);
      datasetChanged(profile.id);
      if (initial && !remove && initial.name !== name.trim()) useStudio.getState().renameField(profile.id, initial.name, name.trim(), kind === "measure");
      useStudio.getState().notify(remove ? `« ${initial?.name} » supprimée.` : `« ${name.trim()} » enregistrée.`);
      onClose();
    } catch (e) {
      const detail = (e as { detail?: { issues?: ModelIssue[] } }).detail;
      setError(detail?.issues?.map((i) => `${i.name} : ${i.error}`).join(" ; ") ?? (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const preview = (check?.preview ?? []).map((v) => (check?.type === "number" ? formatNumber(v) : formatDimension(v, check?.type ?? undefined))).join("  ·  ");
  const canSave = !!name.trim() && !!check?.ok && !checking && !saving;
  const pos = check && !check.ok && typeof check.position === "number" ? Math.min(check.position, expression.length) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className="atelier-pop w-full max-w-2xl rounded-xl border border-border bg-surface text-fg shadow-2xl">
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Icon className="size-4 text-accent-ink" aria-hidden />
          <h2 id={titleId} className="flex-1 text-sm font-semibold">
            {initial ? "Modifier" : "Nouvelle"} {kind === "measure" ? "mesure calculée" : "colonne calculée"} · {profile.name}
          </h2>
          <button type="button" onClick={onClose} aria-label="Fermer" className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg">
            <X className="size-4" aria-hidden />
          </button>
        </header>

        <div className="grid gap-4 p-4 md:grid-cols-[1fr_12rem]">
          <div className="space-y-3">
            <label className="block text-xs">
              <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">Nom</span>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={kind === "measure" ? "ex. Marge" : "ex. Prix TTC"}
                className="w-full rounded-md border border-border bg-field px-2.5 py-1.5 text-sm outline-none focus:border-focus"
              />
            </label>
            <label className="block text-xs">
              <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-muted">Expression</span>
              <textarea
                ref={area}
                value={expression}
                onChange={(e) => setExpression(e.target.value)}
                rows={4}
                spellCheck={false}
                placeholder={EXAMPLES[kind]}
                aria-describedby={`${titleId}-status`}
                className="w-full resize-y rounded-md border border-border bg-field px-2.5 py-2 font-mono text-[13px] outline-none focus:border-focus"
              />
            </label>
            <div id={`${titleId}-status`} role="status" aria-live="polite" className="min-h-14 text-xs">
              {checking && (
                <p className="flex items-center gap-1.5 text-muted">
                  <Loader2 className="size-3 animate-spin" aria-hidden /> Vérification…
                </p>
              )}
              {!checking && check?.ok && (
                <div className="space-y-1">
                  <p className="flex items-center gap-1.5 text-positive">
                    <Check className="size-3.5" aria-hidden /> Expression valide
                    {kind === "column" && check.type ? ` — ${{ number: "nombre", string: "texte", date: "date", boolean: "booléen" }[check.type]}` : ""}
                  </p>
                  <p className="text-muted">
                    {kind === "measure" ? "Valeur sur tout le jeu : " : "Premières valeurs : "}
                    <span className="font-medium tabular-nums text-fg">{preview || "(vide)"}</span>
                  </p>
                </div>
              )}
              {!checking && check && !check.ok && (
                <div className="space-y-1">
                  <p className="flex items-start gap-1.5 text-negative">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {check.error}
                  </p>
                  {pos !== null && (
                    <p className="overflow-x-auto whitespace-pre font-mono text-[12px] text-muted">
                      {expression.slice(0, pos)}
                      <mark className="rounded-sm bg-negative/20 px-0.5 text-negative underline decoration-wavy">{expression.slice(pos, pos + 1) || " "}</mark>
                      {expression.slice(pos + 1)}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>

          <aside className="space-y-3 text-xs" aria-label="Aide à la saisie">
            <div>
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">Fonctions</p>
              <div className="flex flex-wrap gap-1">
                {FUNCTIONS.filter((f) => f.kinds.includes(kind)).map((f) => (
                  <button
                    key={f.name}
                    type="button"
                    onClick={() => insert(f.syntax, f.syntax.length - f.syntax.indexOf("(") - 1)}
                    className="rounded border border-border px-1.5 py-0.5 font-mono text-[11px] hover:border-accent-ink hover:text-accent-ink"
                  >
                    {f.name}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">Champs</p>
              <ul className="max-h-48 space-y-0.5 overflow-y-auto">
                {fields.map((f) => (
                  <li key={`${f.measure}-${f.name}`}>
                    <button
                      type="button"
                      onClick={() => insert(fieldRef(f.name))}
                      className="flex w-full items-center gap-1.5 truncate rounded px-1.5 py-0.5 text-left hover:bg-surface-2"
                      title={f.measure ? "Mesure calculée" : "Colonne"}
                    >
                      {f.measure && <Calculator className="size-3 shrink-0 text-accent-ink" aria-hidden />}
                      <span className="truncate">{f.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <p className="text-[11px] leading-snug text-muted">
              {kind === "measure"
                ? "Une mesure agrège : SUM, AVG, COUNT… Elle se recalcule pour chaque barre, ligne ou sous-total. Division par zéro = vide."
                : "Une colonne calculée s'évalue ligne par ligne et s'utilise comme les autres (axe, légende, filtre, segment)."}{" "}
              Noms avec espaces entre crochets : [chiffre d'affaires].
            </p>
          </aside>
        </div>

        {error && (
          <p role="alert" className="mx-4 mb-3 rounded-md bg-negative/10 px-2.5 py-2 text-xs text-negative">
            {error}
          </p>
        )}
        <footer className="flex items-center gap-2 border-t border-border px-4 py-3">
          {initial &&
            (confirmDelete ? (
              <span className="flex items-center gap-2 text-xs">
                <span className="text-negative">{usages ? `Utilisée par ${usages} visuel(s) de ce rapport, qui afficheront une erreur.` : "Supprimer définitivement ?"}</span>
                <button type="button" onClick={() => void save(true)} className="rounded-md bg-negative px-2.5 py-1 font-medium text-white">
                  Supprimer
                </button>
                <button type="button" onClick={() => setConfirmDelete(false)} className="text-muted hover:text-fg">
                  Annuler
                </button>
              </span>
            ) : (
              <button type="button" onClick={() => setConfirmDelete(true)} className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-negative">
                <Trash2 className="size-3.5" aria-hidden /> Supprimer
              </button>
            ))}
          <span className="ml-auto" />
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-fg">
            Annuler
          </button>
          <button
            type="button"
            disabled={!canSave}
            onClick={() => void save()}
            className={clsx("atelier-btn-primary flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-40")}
          >
            {saving && <Loader2 className="size-3.5 animate-spin" aria-hidden />} Enregistrer
          </button>
        </footer>
      </div>
    </div>
  );
}
