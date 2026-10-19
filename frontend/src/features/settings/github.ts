/** Logique de la synchronisation GitHub côté interface (pure, testée). */

import type { GitHubConfig, LocalState, PullResult, PushResult, ReportSyncState } from "../../types/github";

export const STATE_LABEL: Record<LocalState, string> = { new: "Jamais envoyé", modified: "Modifié", synced: "À jour" };

/** Erreur de saisie de la configuration (null si valide). */
export function configError(c: GitHubConfig): string | null {
  if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(c.repo.trim())) return "Dépôt attendu sous la forme « propriétaire/dépôt ».";
  if (!c.branch.trim() || !/^[A-Za-z0-9._/-]+$/.test(c.branch) || c.branch.includes("..")) return "Nom de branche invalide.";
  const folder = c.folder.trim().replace(/^\/+|\/+$/g, "");
  if (folder.split("/").some((p) => p === ".." || p === "." || p.startsWith(".git"))) return "Dossier invalide.";
  return null;
}

/** Nombre de rapports à envoyer (nouveaux ou modifiés). */
export function pendingCount(reports: ReportSyncState[]): number {
  return reports.filter((r) => r.state !== "synced").length;
}

/** Lignes de compte rendu d'un envoi ou d'une récupération. */
export function resultLines(res: PushResult | PullResult): string[] {
  const lines: string[] = [];
  const list = (title: string, names: string[]) => names.length && lines.push(`${title} : ${names.join(", ")}`);
  if ("pushed" in res) {
    list("Envoyés", res.pushed);
    list("Plus récents sur GitHub (à récupérer)", res.remote_newer);
  } else {
    list("Importés", res.imported);
    list("Mis à jour", res.updated);
    list("Copies importées", res.copies);
    list("Version du poste gardée", res.kept_local);
    for (const s of res.skipped) lines.push(`Ignoré : ${s.path} — ${s.reason}`);
  }
  return lines;
}
