/** Miroir de backend/app/schemas/github.py — garder synchronisé. */

export type Resolution = "local" | "remote" | "copy";
export type LocalState = "new" | "modified" | "synced";

export interface GitHubConfig {
  /** « propriétaire/dépôt ». */
  repo: string;
  branch: string;
  folder: string;
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
