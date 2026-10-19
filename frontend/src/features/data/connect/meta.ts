/** Présentation des connecteurs (icônes, libellés, champs) et petites fonctions pures testées. */

import { Cloud, Database, FileSpreadsheet, KanbanSquare, type LucideIcon, Server, Table2 } from "lucide-react";

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
  return c.path?.split(/[\\/]/).pop() ?? "";
}

/** Formulaire vide pour un type de source. */
export function emptyForm(kind: ConnectorKind): ConnectionInput {
  const base: ConnectionInput = { name: KIND_META[kind].label, kind };
  if (SERVER_KINDS.includes(kind)) return { ...base, host: "", port: null, database: "", username: "", password: "", encrypt: false };
  if (kind === "sharepoint") return { ...base, name: "SharePoint", tenant: "", client_id: "" };
  if (kind === "atelier_projets") return { ...base, base_url: "" };
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
  if ((form.kind === "sqlite" || form.kind === "file") && !form.path?.trim()) return "Indiquez le chemin du fichier.";
  if (form.kind === "atelier_projets" && form.base_url?.trim() && !/^https?:\/\/[^/\s]+/i.test(form.base_url.trim()))
    return "Adresse attendue : http://127.0.0.1:3000.";
  return null;
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
    return c.kind === "mysql" && source.table.schema === c.database ? source.table.name : tableLabel(source.table);
  }
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
