/** Présentation des connecteurs (icônes, libellés, champs) et petites fonctions pures testées. */

import { Cloud, Database, FileSpreadsheet, Globe, KanbanSquare, type LucideIcon, Server, Snowflake, Table2, Warehouse } from "lucide-react";

import type { Connection, ConnectionInput, ConnectorKind, SourceSpec, TableRef } from "../../../types/connection";
import { SERVER_KINDS, tableLabel } from "../../../types/connection";

/** Dossier où l'application de bureau Atelier Tab publie ses tables (docs/SUITE.md §4.2). */
export const ATELIER_TAB_DEFAULT_FOLDER = "~/Atelier_Tab/exports";
/** Adresse de l'API d'Atelier Projets (docs/SUITE.md §2). */
export const ATELIER_PROJETS_DEFAULT_URL = "http://127.0.0.1:3000";

export const KIND_META: Record<ConnectorKind, { icon: LucideIcon; label: string; hostPlaceholder?: string; pathPlaceholder?: string }> = {
  sqlserver: { icon: Server, label: "SQL Server", hostPlaceholder: "sql01.entreprise.local\\PROD" },
  postgres: { icon: Database, label: "PostgreSQL", hostPlaceholder: "localhost" },
  mysql: { icon: Database, label: "MySQL / MariaDB", hostPlaceholder: "localhost" },
  sqlite: { icon: Database, label: "SQLite", pathPlaceholder: "~/Documents/boutique.db" },
  file: { icon: FileSpreadsheet, label: "Fichier synchronisé", pathPlaceholder: "~/Library/CloudStorage/OneDrive-Entreprise/Ventes/objectifs.xlsx" },
  snowflake: { icon: Snowflake, label: "Snowflake", hostPlaceholder: "monorg-moncompte" },
  bigquery: { icon: Warehouse, label: "Google BigQuery" },
  web: { icon: Globe, label: "Fichier web (URL)", hostPlaceholder: "https://donnees.exemple.fr/exports/ventes.csv" },
  sharepoint: { icon: Cloud, label: "SharePoint Online" },
  atelier_tab: { icon: Table2, label: "Atelier Tab", pathPlaceholder: ATELIER_TAB_DEFAULT_FOLDER },
  atelier_projets: { icon: KanbanSquare, label: "Atelier Projets", hostPlaceholder: ATELIER_PROJETS_DEFAULT_URL },
};

/** Ligne secondaire d'une connexion enregistrée (serveur / base, fichier ou compte). */
export function describeConnection(c: Connection): string {
  if (SERVER_KINDS.includes(c.kind)) return [c.host, c.database].filter(Boolean).join(" · ");
  if (c.kind === "sharepoint") return c.signed_in ? (c.account ?? "Connecté") : "Non connecté";
  if (c.kind === "atelier_tab") return c.path?.trim() || ATELIER_TAB_DEFAULT_FOLDER;
  if (c.kind === "atelier_projets") return (c.base_url?.trim() || ATELIER_PROJETS_DEFAULT_URL).replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (c.kind === "web") return webFileName(c.base_url ?? "") || (c.base_url ?? "");
  if (c.kind === "snowflake") return [c.host, c.database, c.warehouse].filter(Boolean).join(" · ");
  if (c.kind === "bigquery") return c.database ?? "";
  return c.path?.split(/[\\/]/).pop() ?? "";
}

/** Formulaire vide pour un type de source. */
export function emptyForm(kind: ConnectorKind): ConnectionInput {
  const base: ConnectionInput = { name: KIND_META[kind].label, kind };
  if (SERVER_KINDS.includes(kind)) return { ...base, host: "", port: null, database: "", username: "", password: "", encrypt: false };
  if (kind === "sharepoint") return { ...base, name: "SharePoint", tenant: "", client_id: "" };
  if (kind === "atelier_projets") return { ...base, base_url: "" };
  if (kind === "web") return { ...base, base_url: "", username: "", password: "" };
  if (kind === "snowflake") return { ...base, host: "", database: "", username: "", password: "", warehouse: "", role: "" };
  if (kind === "bigquery") return { ...base, database: "", password: "", max_gb: 10 };
  return { ...base, path: "" };
}

/** Formulaire d'édition d'une connexion enregistrée (mot de passe vide = inchangé). */
export function formOf(c: Connection): ConnectionInput {
  const { id: _id, created_at: _c, has_password: _h, signed_in: _s, account: _a, ...fields } = c;
  return { ...fields, password: null };
}

/** Corps envoyé à l'API : champs vides → null ; mot de passe non saisi à l'édition → absent (inchangé). */
export function toInput(form: ConnectionInput, editing: boolean): ConnectionInput {
  const clean = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);
  const out: ConnectionInput = {
    name: form.name.trim() || KIND_META[form.kind].label,
    kind: form.kind,
    host: clean(form.host),
    port: form.port ?? null,
    database: clean(form.database),
    username: clean(form.username),
    encrypt: !!form.encrypt,
    path: clean(form.path),
    tenant: clean(form.tenant),
    client_id: clean(form.client_id),
    base_url: clean(form.base_url),
  };
  // Suite Atelier : aucun secret, jamais de champ mot de passe.
  if (form.kind === "atelier_tab" || form.kind === "atelier_projets") return out;
  if (!editing || (form.password ?? "") !== "") out.password = form.password ?? "";
  return out;
}

/** Champ obligatoire manquant, ou null. */
export function missingField(form: ConnectionInput): string | null {
  if (SERVER_KINDS.includes(form.kind) && !form.host?.trim()) return "Indiquez le serveur.";
  if (form.kind === "snowflake" && !/^[A-Za-z0-9._-]{3,255}$/.test(form.host?.trim() ?? "")) return "Indiquez l'identifiant du compte Snowflake (ex. monorg-moncompte).";
  if (form.kind === "snowflake" && !form.database?.trim()) return "Indiquez la base Snowflake (ex. ANALYTICS).";
  if (form.kind === "bigquery" && !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(form.database?.trim() ?? "")) return "Indiquez le projet Google Cloud (ex. mon-projet-123).";
  if ((form.kind === "sqlite" || form.kind === "file") && !form.path?.trim()) return "Indiquez le chemin du fichier.";
  if (form.kind === "sharepoint") {
    const entra = entraAppError(form.client_id, form.tenant);
    if (entra) return entra;
  }
  if (form.kind === "web") {
    const url = form.base_url?.trim() ?? "";
    if (!url) return "Indiquez l'adresse du fichier.";
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return "Adresse attendue : https://… (http ou https).";
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "Adresse attendue : https://… (http ou https).";
    if (parsed.username || parsed.password) return "Pas d'identifiant dans l'adresse : utilisez les champs Utilisateur et Jeton.";
  }
  if (form.kind === "atelier_projets" && form.base_url?.trim()) {
    const url = form.base_url.trim();
    if (!/^https?:\/\/[^/\s]+/i.test(url)) return "Adresse attendue : http://127.0.0.1:3000.";
    if (!isLoopbackUrl(url)) return "Atelier Projets doit tourner sur cette machine : utilisez 127.0.0.1, localhost ou ::1 (par exemple http://127.0.0.1:3000).";
  }
  return null;
}

const ENTRA_GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const ENTRA_TENANT = /^[a-z0-9](?:[a-z0-9.-]{0,198}[a-z0-9])?$/i;

/** Autorisations Microsoft Graph déléguées demandées à la connexion (les mêmes que `SCOPES` du backend). */
export const ENTRA_PERMISSIONS = ["Sites.Read.All", "Files.Read.All", "User.Read", "offline_access"] as const;

/**
 * Étapes à suivre dans Entra pour créer l'application de SharePoint, dans l'ordre des écrans du centre
 * d'administration (entra.microsoft.com). Écrites dans la fenêtre : rien n'est à chercher ailleurs.
 */
export const ENTRA_STEPS: { title: string; detail: string }[] = [
  {
    title: "Créer l'inscription",
    detail: "Sur entra.microsoft.com : Applications → Inscriptions d'applications → Nouvelle inscription. Nom : « Atelier Viz ». Types de comptes pris en charge : « Comptes dans cet annuaire d'organisation uniquement » (locataire unique). URI de redirection : laisser vide. Puis « S'inscrire ».",
  },
  {
    title: "En faire un client public",
    detail: "Dans l'application : Authentification → Paramètres avancés → « Autoriser les flux de clients publics » : Oui, puis Enregistrer. C'est ce qui permet la connexion par code d'appareil ; aucun secret client n'est à créer.",
  },
  {
    title: "Donner les autorisations de lecture",
    detail: `API autorisées → Ajouter une autorisation → Microsoft Graph → Autorisations déléguées : ${ENTRA_PERMISSIONS.join(", ")}. Puis « Accorder un consentement d'administrateur » si votre organisation l'exige.`,
  },
  {
    title: "Recopier les deux identifiants",
    detail: "Page Vue d'ensemble : « ID d'application (client) » et « ID de l'annuaire (locataire) », à coller ci-dessous.",
  },
  {
    title: "Se connecter par code d'appareil",
    detail: "Une fois la connexion SharePoint enregistrée, en mode « En ligne » : « Se connecter à Microsoft 365 » affiche un code à saisir sur microsoft.com/devicelogin avec votre compte. Atelier Viz ne voit jamais votre mot de passe.",
  },
];

/** Identifiant d'application ou locataire mal formés (mêmes règles que l'API), ou null. Les deux peuvent être vides. */
export function entraAppError(clientId: string | null | undefined, tenant: string | null | undefined): string | null {
  const id = clientId?.trim() ?? "";
  const dir = tenant?.trim() ?? "";
  if (id && !ENTRA_GUID.test(id)) return "Identifiant d'application attendu : 36 caractères, comme 00000000-0000-0000-0000-000000000000 (« ID d'application (client) » dans Entra).";
  if (dir && !ENTRA_TENANT.test(dir)) return "Locataire attendu : l'« ID de l'annuaire (locataire) » d'Entra ou le domaine de l'entreprise (contoso.fr), sans adresse ni espace.";
  return null;
}

/**
 * Vrai si l'interface est servie par une autre machine que celle de la personne (Atelier Viz sur un serveur) :
 * un « chemin sur cette machine » y désigne alors le serveur, pas l'ordinateur devant soi.
 */
export function isRemoteHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "" || host === "localhost" || host === "::1" || host.endsWith(".localhost")) return false;
  return !/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Mention d'un pilote absent : la commande sur son ordinateur ; sur un serveur, ce qui manque à l'installation. */
export function driverNote(installHint: string | null, remote: boolean): string {
  return remote ? "Pilote absent sur le serveur d'Atelier Viz" : `Pilote à installer : ${installHint ?? ""}`;
}

/** Nom de fichier à la fin d'une adresse (« ventes.csv »), sans paramètres. */
export function webFileName(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? "");
  } catch {
    return "";
  }
}

/** Vrai si l'adresse désigne cette machine : `localhost`, 127.0.0.0/8 ou ::1 (docs/SUITE.md §4.3, vérifié aussi par l'API). */
export function isLoopbackUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host === "[::1]") return true;
  // L'analyseur d'URL normalise déjà les écritures exotiques (0x7f.1, 2130706433…) en IPv4 décimale.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Nom proposé pour le jeu importé. */
export function suggestedName(c: Connection, source: SourceSpec): string {
  if (source.query?.trim()) return `${c.name} (requête)`;
  if (source.url?.trim()) {
    const last = decodeURIComponent(source.url.split("?")[0]?.replace(/\/(AllItems|[^/]+)\.aspx$/i, "").split("/").filter(Boolean).pop() ?? "");
    return source.table ? `${last.replace(/\.xlsx$/i, "")} — ${source.table.name}` : last || "SharePoint";
  }
  if (source.table) {
    if (c.kind === "atelier_tab" || c.kind === "atelier_projets") return source.table.name;
    if (c.kind === "file") return `${(c.path?.split(/[\\/]/).pop() ?? "").replace(/\.xlsx$/i, "")} — ${source.table.name}`;
    if (c.kind === "web") return `${(webFileName(c.base_url ?? "") || c.name).replace(/\.xlsx$/i, "")} — ${source.table.name}`;
    return c.kind === "mysql" && source.table.schema === c.database ? source.table.name : tableLabel(source.table);
  }
  if (c.kind === "web") return webFileName(c.base_url ?? "") || c.name;
  return c.path?.split(/[\\/]/).pop() ?? c.name;
}

/** Tables regroupées par schéma, filtrées par une recherche (insensible à la casse et aux accents). */
export function groupTables(tables: TableRef[], search: string): [string, TableRef[]][] {
  const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const q = fold(search.trim());
  const groups = new Map<string, TableRef[]>();
  for (const t of tables) {
    if (q && !fold(`${t.schema ?? ""}.${t.name}`).includes(q)) continue;
    const key = t.schema ?? "";
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  return [...groups.entries()];
}

/** « il y a 5 min », « il y a 2 h », « le 12/10/2026 ». */
export function sinceLabel(iso: string, now = Date.now()): string {
  const minutes = Math.round((now - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "à l'instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  if (minutes < 24 * 60) return `il y a ${Math.round(minutes / 60)} h`;
  return `le ${new Date(iso).toLocaleDateString("fr-FR")}`;
}

/** Groupes de tables publiées par Atelier Tab : un groupe par projet (« Sans projet » en dernier), tables triées. */
export function groupSnapshots(tables: TableRef[], search: string): [string, TableRef[]][] {
  const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const q = fold(search.trim());
  const groups = new Map<string, TableRef[]>();
  for (const t of tables) {
    if (q && !fold(`${t.schema ?? ""} ${t.name}`).includes(q)) continue;
    const key = t.schema?.trim() || "Sans projet";
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "Sans projet" ? 1 : b === "Sans projet" ? -1 : a.localeCompare(b, "fr")))
    .map(([k, list]) => [k, [...list].sort((x, y) => x.name.localeCompare(y.name, "fr"))]);
}

/** « 3 lignes · publiée le 18/10/2026 à 14:57 » : ligne secondaire d'une table publiée ou d'un jeu. */
export function sourceDetails(t: TableRef): string {
  const parts: string[] = [];
  if (typeof t.rows === "number") parts.push(`${t.rows.toLocaleString("fr-FR")} ligne${t.rows > 1 ? "s" : ""}`);
  if (t.updated_at) {
    const d = new Date(t.updated_at);
    if (!Number.isNaN(d.getTime()))
      parts.push(`publiée le ${d.toLocaleDateString("fr-FR")} à ${d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`);
  }
  return parts.join(" · ");
}
