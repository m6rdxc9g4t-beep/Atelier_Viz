/** Logique de la synchronisation GitHub côté interface (pure, testée). */

import type { GitHubConfig, LocalState, PullResult, PushResult, ReportSyncState } from "../../types/github";

export const STATE_LABEL: Record<LocalState, string> = { new: "Jamais envoyé", modified: "Modifié", synced: "À jour" };

/** Erreur de saisie de la configuration (null si valide). */
export function configError(c: GitHubConfig): string | null {
  if (!/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(c.repo.trim())) return "Dépôt attendu sous la forme « propriétaire/dépôt ».";
  if (!c.branch.trim() || !/^[A-Za-z0-9._/-]+$/.test(c.branch) || c.branch.includes("..")) return "Nom de branche invalide.";
  const folder = c.folder.trim().replace(/^\/+|\/+$/g, "");
  if (folder.split("/").some((p) => p === ".." || p === "." || p.startsWith(".git"))) return "Dossier invalide.";
  if (c.api_url && apiUrlError(c.api_url)) return apiUrlError(c.api_url);
  return null;
}

export const DEFAULT_API = "https://api.github.com";

/** Adresse d'API GitHub Enterprise invalide (https obligatoire, sauf machine locale) ; null si valide. */
export function apiUrlError(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return "Adresse de l'API invalide (ex. https://github.mon-entreprise.fr/api/v3).";
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return "Adresse de l'API : https:// obligatoire (le jeton y est envoyé).";
  if (url.username || url.password || url.search || url.hash) return "Adresse de l'API : ni identifiant, ni paramètre, ni ancre.";
  return null;
}

/** Site web d'un serveur GitHub (liens « créer un jeton », commits) à partir de l'adresse de son API. */
export function webUrl(apiUrl: string | undefined): string {
  if (!apiUrl || apiUrl === DEFAULT_API) return "https://github.com";
  try {
    const u = new URL(apiUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "https://github.com";
  }
}

/** « il y a 2 jours · François · Deuxième version ». */
export function versionLabel(v: { message: string; author: string | null }): string {
  return [v.author, v.message].filter(Boolean).join(" · ");
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

/** Ce qui part vers GitHub, selon l'option de nettoyage (texte exact affiché dans les réglages). */
export function sharedContent(stripPrivate: boolean): { sent: string; removed: string | null; never: string } {
  return {
    sent: "un fichier JSON par rapport : pages, visuels, champs utilisés, titres, textes, thème et signets",
    removed: stripPrivate
      ? "les valeurs des filtres (page et visuel), les sélections des segments, les chemins d'exploration, l'état des signets et les adresses des boutons webhook"
      : null,
    never: "les tables des jeux, la base locale, les connexions, les planifications, les alertes et les mots de passe",
  };
}

/** Avertissement de visibilité du dépôt (null : privé ou inconnu). */
export function visibilityWarning(repoPrivate: boolean | null | undefined, stripPrivate: boolean): string | null {
  if (repoPrivate !== false) return null;
  return stripPrivate
    ? "Dépôt public : la structure des rapports (noms des champs, titres, textes) sera lisible par tout le monde."
    : "Dépôt public et nettoyage désactivé : les valeurs des filtres et sélections et les adresses de webhook seraient publiées.";
}
