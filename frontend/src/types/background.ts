/** Miroir de app/background.py et app/services/background_job.py : actualisation quand l'application est fermée. */

export interface BackgroundStatus {
  last_run_at: string | null;
  /** never · done · app_open · error */
  status: string;
  refreshed: number;
  failed: number;
  skipped: number;
  message: string | null;
}

export interface BackgroundJobState {
  supported: boolean;
  platform: string;
  reason: string | null;
  installed: boolean;
  interval_minutes: number | null;
  location: string | null;
  last: BackgroundStatus;
}

export interface BackgroundJobInput {
  enabled: boolean;
  interval_minutes: number;
}
