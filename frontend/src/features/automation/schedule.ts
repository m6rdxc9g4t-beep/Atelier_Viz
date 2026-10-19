/** Libellés et contrôles des planifications d'actualisation (logique pure, testée). */

import type { RefreshRun, RefreshSchedule, ScheduleState } from "../../types/refresh";

export const DEFAULT_SCHEDULE: RefreshSchedule = { mode: "off", every: 1, unit: "hours", at: "07:00" };

const timeFmt = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", month: "short" });

/** « Toutes les 15 minutes », « Chaque jour à 07:00 », « Désactivée ». */
export function describeSchedule(s: RefreshSchedule): string {
  if (s.mode === "off") return "Désactivée";
  if (s.mode === "daily") return `Chaque jour à ${s.at}`;
  if (s.every === 1) return s.unit === "hours" ? "Toutes les heures" : "Toutes les minutes";
  return `Toutes les ${s.every} ${s.unit === "hours" ? "heures" : "minutes"}`;
}

/** Erreur de saisie (null si la planification est valide). */
export function scheduleError(s: RefreshSchedule): string | null {
  if (s.mode === "interval") {
    if (!Number.isInteger(s.every) || s.every < 1) return "L'intervalle doit être un nombre entier positif.";
    const minutes = s.every * (s.unit === "hours" ? 60 : 1);
    if (minutes > 7 * 24 * 60) return "Une semaine au plus : utilisez « Chaque jour ».";
  }
  if (s.mode === "daily" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.at)) return "Heure attendue au format HH:MM.";
  return null;
}

/** Date d'une exécution, relative au jour courant (« aujourd'hui 07:00 », « demain 07:00 », « lun. 20 oct. 07:00 »). */
export function whenLabel(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(d) - day(now)) / 86_400_000);
  const prefix = diff === 0 ? "aujourd'hui" : diff === 1 ? "demain" : diff === -1 ? "hier" : dayFmt.format(d);
  return `${prefix} ${timeFmt.format(d)}`;
}

export function durationLabel(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toLocaleString("fr-FR", { maximumFractionDigits: 1 })} s`;
  return `${Math.round(ms / 60_000)} min`;
}

export const STATUS_LABEL: Record<RefreshRun["status"], string> = { success: "Réussie", error: "Échec", skipped: "Sautée", interrupted: "Interrompue" };

/** Avertissement à afficher pour une planification (source SharePoint hors ligne…). */
export function scheduleWarning(state: ScheduleState, online: boolean): string | null {
  if (state.needs_online && !online && state.schedule.mode !== "off") {
    return "SharePoint Online exige le mode « En ligne » : hors ligne, les exécutions sont sautées.";
  }
  return null;
}
