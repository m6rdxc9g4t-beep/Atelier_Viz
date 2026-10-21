/** Miroir de backend/app/schemas/github.py — garder synchronisé. */

export type Resolution = "local" | "remote" | "copy";
export type LocalState = "new" | "modified" | "synced";

export interface GitHubConfig {
  /** « propriétaire/dépôt ». */
  repo: string;
  branch: string;
  folder: string;
  /**
   * Retirer avant l'envoi filtres, sélections, exploration et adresses de webhook (défaut : vrai) ;
   * à la récupération, ces champs restent ceux du poste.
   */
  strip_private: boolean;
  /** API REST : https://api.github.com, ou GitHub Enterprise Server (https://<hôte>/api/v3). */
  api_url?: string;
}

/** `token` absent = inchangé ; chaîne vide = effacé. Jamais renvoyé par l'API. */
export interface GitHubConfigInput extends GitHubConfig {
  token?: string | null;
}

export interface SyncEvent {
  at: string;
  summary: string;
  commit_url: string | null;
}

export interface ReportSyncState {
  id: string;
  name: string;
  updated_at: string;
  state: LocalState;
}

export interface GitHubState {
  config: GitHubConfig | null;
  has_token: boolean;
  token_from_env: boolean;
  online: boolean;
  account: string | null;
  /** Visibilité lue au dernier test de connexion (null = inconnue). */
  repo_private: boolean | null;
  last_push: SyncEvent | null;
  last_pull: SyncEvent | null;
  reports: ReportSyncState[];
}

export interface GitHubTest {
  ok: boolean;
  message: string;
  account: string | null;
  can_push: boolean | null;
  default_branch: string | null;
  repo_url: string | null;
  /** false = dépôt public (voir `warning`). */
  private: boolean | null;
  warning: string | null;
}

export interface Conflict {
  id: string;
  name: string;
  local_updated_at: string | null;
  remote_name: string | null;
  remote_updated_at: string | null;
}

export interface PushRequest {
  report_ids?: string[] | null;
  message?: string | null;
  resolutions?: Record<string, "local">;
}

export interface PushResult {
  commit_sha: string | null;
  commit_url: string | null;
  pushed: string[];
  unchanged: number;
  remote_newer: string[];
  conflicts: Conflict[];
  message: string;
}

export interface PullRequest {
  resolutions?: Record<string, Resolution>;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface PullResult {
  imported: string[];
  updated: string[];
  copies: string[];
  kept_local: string[];
  unchanged: number;
  conflicts: Conflict[];
  skipped: SkippedFile[];
  message: string;
}

/** Un commit qui a modifié le fichier d'un rapport. */
export interface ReportVersion {
  sha: string;
  message: string;
  author: string | null;
  date: string | null;
  url: string | null;
}

export interface ReportVersionDetail {
  sha: string;
  name: string;
  pages: string[];
  visuals: number;
  updated_at: string | null;
}

export interface RestoreRequest {
  sha: string;
  as_copy?: boolean;
}

export interface RestoreResult {
  report_id: string;
  name: string;
  message: string;
}
