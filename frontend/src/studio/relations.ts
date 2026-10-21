/** Relations entre jeux : valeurs par défaut et textes du diagnostic (logique pure, testée). */

import type { DatasetProfile, DatasetSummary, Relation, RelationCheck } from "../types/dataset";

/** Nom de relation à partir du nom du jeu lié : « regions.csv » → « regions ». */
export function relationName(datasetName: string, taken: string[] = []): string {
  const stem = datasetName.replace(/\.[a-z0-9]{2,5}$/i, "").trim();
  const clean = stem
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 30) || "lien";
  let name = clean;
  let n = 2;
  while (taken.includes(name)) name = `${clean}_${n++}`;
  return name;
}

/**
 * Relation proposée vers `target` : colonnes de même nom de part et d'autre (en préférant celle dont
 * les valeurs sont uniques côté `target`), sinon les premières colonnes.
 */
export function suggestRelation(source: DatasetProfile, target: DatasetProfile): Relation {
  const own = source.columns.filter((c) => !c.calculated && !c.related);
  const shared = own.filter((c) => target.columns.some((t) => t.name === c.name));
  const unique = (name: string) => {
    const t = target.columns.find((x) => x.name === name);
    return t ? t.distinct === target.rows - t.nulls : false;
  };
  const pick = shared.find((c) => unique(c.name)) ?? shared[0];
  const to = pick?.name ?? target.columns.find((t) => t.distinct === target.rows - t.nulls)?.name ?? target.columns[0]?.name ?? "";
  return {
    name: relationName(target.name, (source.model?.relations ?? []).map((r) => r.name)),
    dataset_id: target.id,
    from_column: pick?.name ?? own[0]?.name ?? "",
    to_column: to,
    columns: null,
  };
}

/** Une ligne de résumé : « region → regions.csv · region ». */
export function relationSummary(rel: Relation, datasets: DatasetSummary[]): string {
  const target = datasets.find((d) => d.id === rel.dataset_id)?.name ?? "jeu supprimé";
  return `${rel.from_column} → ${target} · ${rel.to_column}`;
}

/** Diagnostic lisible : correspondance des clés et doublons. */
export function checkMessages(check: RelationCheck, targetName: string): { tone: "ok" | "warn" | "error"; text: string }[] {
  if (!check.ok) return [{ tone: "error", text: check.error ?? "Relation impossible." }];
  const out: { tone: "ok" | "warn" | "error"; text: string }[] = [];
  const fmt = (n: number) => n.toLocaleString("fr-FR");
  const missing = check.rows - check.matched;
  if (check.rows === 0) out.push({ tone: "warn", text: "Ce jeu ne contient aucune ligne." });
  else if (missing === 0) out.push({ tone: "ok", text: `Toutes les lignes (${fmt(check.rows)}) trouvent leur correspondance.` });
  else
    out.push({
      tone: check.matched === 0 ? "error" : "warn",
      text: `${fmt(missing)} ligne${missing > 1 ? "s" : ""} sur ${fmt(check.rows)} sans correspondance${check.unmatched_sample.length ? ` (ex. ${check.unmatched_sample.join(", ")})` : ""} : leurs colonnes liées seront vides.`,
    });
  if (check.duplicates > 0)
    out.push({
      tone: "warn",
      text: `${fmt(check.duplicates)} clé${check.duplicates > 1 ? "s" : ""} en double dans « ${targetName} » : la première ligne est retenue (les totaux restent justes).`,
    });
  return out;
}
