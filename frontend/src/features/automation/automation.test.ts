import { afterEach, describe, expect, it, vi } from "vitest";

import { changedDatasets, noteVersion, pollVersions } from "../../hooks/useDataVersions";
import { api } from "../../lib/api";
import type { DatasetProfile } from "../../types/dataset";
import { parseRoute } from "../../lib/router";
import { STATUS_LABEL, describeSchedule, durationLabel, scheduleError, scheduleWarning, whenLabel } from "./schedule";
import type { ScheduleState } from "../../types/refresh";

describe("planifications", () => {
  it("nomme chaque statut du journal, interruption à l'arrêt comprise", () => {
    expect(STATUS_LABEL).toEqual({ success: "Réussie", error: "Échec", skipped: "Sautée", interrupted: "Interrompue" });
  });

  it("décrit et contrôle une planification", () => {
    expect(describeSchedule({ mode: "off", every: 1, unit: "hours", at: "07:00" })).toBe("Désactivée");
    expect(describeSchedule({ mode: "interval", every: 15, unit: "minutes", at: "07:00" })).toBe("Toutes les 15 minutes");
    expect(describeSchedule({ mode: "interval", every: 1, unit: "hours", at: "07:00" })).toBe("Toutes les heures");
    expect(describeSchedule({ mode: "daily", every: 1, unit: "hours", at: "06:30" })).toBe("Chaque jour à 06:30");
    expect(scheduleError({ mode: "interval", every: 0, unit: "minutes", at: "07:00" })).toMatch(/entier positif/);
    expect(scheduleError({ mode: "interval", every: 200, unit: "hours", at: "07:00" })).toMatch(/semaine/);
    expect(scheduleError({ mode: "daily", every: 1, unit: "hours", at: "7h" })).toMatch(/HH:MM/);
    expect(scheduleError({ mode: "daily", every: 1, unit: "hours", at: "23:59" })).toBeNull();
  });

  it("formate dates et durées", () => {
    const now = new Date(2026, 9, 19, 10, 0);
    expect(whenLabel(new Date(2026, 9, 19, 7, 5).toISOString(), now)).toBe("aujourd'hui 07:05");
    expect(whenLabel(new Date(2026, 9, 20, 7, 0).toISOString(), now)).toBe("demain 07:00");
    expect(durationLabel(420)).toBe("420 ms");
    expect(durationLabel(1500)).toBe("1,5 s");
  });

  it("prévient qu'une source SharePoint est sautée hors ligne", () => {
    const state = { needs_online: true, schedule: { mode: "daily", every: 1, unit: "hours", at: "07:00" } } as ScheduleState;
    expect(scheduleWarning(state, false)).toMatch(/En ligne/);
    expect(scheduleWarning(state, true)).toBeNull();
  });

  it("route l'écran Automatisation", () => {
    expect(parseRoute("#/automatisation")).toEqual({ name: "automation" });
  });
});

describe("rechargement après actualisation planifiée", () => {
  afterEach(() => vi.restoreAllMocks());

  it("ne signale que les jeux dont la version a changé", () => {
    const previous = new Map([["a", "v1"], ["b", "v1"]]);
    expect(changedDatasets(previous, { a: "v1", b: "v2", c: "v1" })).toEqual(["b"]);
  });

  it("relit le profil d'un jeu actualisé en arrière-plan, une seule fois", async () => {
    const versions = vi.spyOn(api.refresh, "versions");
    const get = vi.spyOn(api.datasets, "get").mockResolvedValue({ id: "d1" } as DatasetProfile);
    versions.mockResolvedValueOnce({ d1: "2026-10-19T08:00:00Z" });
    expect(await pollVersions()).toEqual([]); // première lecture : référence
    versions.mockResolvedValueOnce({ d1: "2026-10-19T09:00:00Z" });
    expect(await pollVersions()).toEqual(["d1"]);
    expect(get).toHaveBeenCalledWith("d1");
    versions.mockResolvedValueOnce({ d1: "2026-10-19T09:00:00Z" });
    expect(await pollVersions()).toEqual([]);
    // Actualisation faite par l'utilisateur : déjà rechargée, pas de second passage.
    noteVersion("d1", "2026-10-19T10:00:00Z");
    versions.mockResolvedValueOnce({ d1: "2026-10-19T10:00:00Z" });
    expect(await pollVersions()).toEqual([]);
  });
});
