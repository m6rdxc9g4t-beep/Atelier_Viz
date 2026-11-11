import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, api } from "../../lib/api";
import type { DatasetSummary } from "../../types/dataset";
import type { ReportSummary } from "../../types/report";
import { ReportsHome } from "./ReportsHome";

const reports = [
  { id: "aaaaaaaaaaaa", name: "Ventes", pages: 2, visuals: 9, updated_at: "2026-11-02T10:00:00Z" },
  { id: "bbbbbbbbbbbb", name: "Budget", pages: 1, visuals: 1, updated_at: "2026-11-03T10:00:00Z" },
] as unknown as ReportSummary[];
const datasets = [
  { id: "ds1", name: "une_ligne.csv", rows: 1 },
  { id: "ds2", name: "ventes.csv", rows: 573 },
] as unknown as DatasetSummary[];

describe("accueil des rapports", () => {
  beforeEach(() => {
    vi.spyOn(api.exemples, "list").mockResolvedValue([]);
    vi.spyOn(api.datasets, "list").mockResolvedValue(datasets);
    vi.spyOn(api.reports, "list").mockResolvedValue(structuredClone(reports));
  });
  afterEach(() => vi.restoreAllMocks());

  it("accorde « ligne » au nombre de lignes du jeu", async () => {
    render(<ReportsHome />);
    expect(await screen.findByRole("option", { name: "une_ligne.csv (1 ligne)" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "ventes.csv (573 lignes)" })).toBeInTheDocument();
  });

  it("une liste illisible n'est ni un chargement sans fin ni une liste vide : message et « Réessayer »", async () => {
    const list = vi.spyOn(api.reports, "list").mockRejectedValueOnce(new ApiError(0, "Le serveur local ne répond pas."));
    render(<ReportsHome />);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Les rapports n'ont pas pu être lus : Le serveur local ne répond pas.");
    expect(screen.queryByLabelText("Chargement")).not.toBeInTheDocument();
    expect(screen.queryByText("Aucun rapport pour l'instant.")).not.toBeInTheDocument();

    await userEvent.click(within(alert).getByRole("button", { name: "Réessayer" }));
    expect(await screen.findByText("Ventes")).toBeInTheDocument();
    expect(list).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("une suppression refusée est dite, et le rapport reste dans la liste", async () => {
    vi.spyOn(api.reports, "remove").mockRejectedValue(new ApiError(500, "Écriture impossible."));
    render(<ReportsHome />);
    await userEvent.click(await screen.findByRole("button", { name: "Supprimer Ventes" }));
    // La confirmation prend le focus sur « Annuler » : une seconde frappe d'Entrée ne supprime rien.
    expect(screen.getByRole("button", { name: "Annuler" })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Supprimer" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("« Ventes » n'a pas été supprimé : Écriture impossible.");
    expect(screen.getByText("Ventes")).toBeInTheDocument();
  });

  it("supprime le rapport confirmé", async () => {
    const remove = vi.spyOn(api.reports, "remove").mockResolvedValue(undefined);
    render(<ReportsHome />);
    await userEvent.click(await screen.findByRole("button", { name: "Supprimer Budget" }));
    await userEvent.click(screen.getByRole("button", { name: "Supprimer" }));
    expect(remove).toHaveBeenCalledWith("bbbbbbbbbbbb");
    expect(screen.queryByText("Budget")).not.toBeInTheDocument();
    expect(screen.getByText("Ventes")).toBeInTheDocument();
  });
});
