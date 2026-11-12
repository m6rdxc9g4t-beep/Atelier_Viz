import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../../lib/api";
import { EXAMPLES_EVENT } from "../../lib/exemples";
import type { DatasetProfile } from "../../types/dataset";
import type { ExempleCharge, ExempleHistoire } from "../../types/exemples";
import type { Report, ReportSummary } from "../../types/report";
import { Sidebar } from "./Sidebar";

const histoire = (charge: boolean): ExempleHistoire => ({
  id: "studio-garance",
  titre: "Studio Garance",
  sous_titre: "Clôture comptable d'un studio de design",
  secteur: "Compta",
  resume: "Un studio de design graphique d'Arles clôture son mois.",
  parcours: [
    { app: "convert", titre: "Convert", texte: "Les relevés sont convertis." },
    { app: "viz", titre: "Viz", texte: "Le poste Matériel dépasse : l'alerte se déclenche." },
    { app: "nexus", titre: "Nexus", texte: "L'alerte devient une tâche." },
  ],
  jeux: ["Studio Garance — opérations"],
  alerte: "Matériel au-dessus du budget",
  rapport: "Exemple — Studio Garance",
  charge,
});

const profile = { id: "ops000000001", name: "Studio Garance — opérations", format: "atelier_table", rows: 0, columns_count: 0, created_at: "", columns: [], sample: [] } as unknown as DatasetProfile;
const charge: ExempleCharge = { histoire: "studio-garance", datasets: [], operations_id: "ops000000001", alerte_id: "a1", alerte_declenchee: true, rapport: "Exemple — Studio Garance" };

const open = async () => {
  const button = screen.getByRole("button", { name: "Exemples de la suite" });
  await userEvent.click(button);
  return { button, dialog: await screen.findByRole("dialog", { name: "Exemples de la suite" }) };
};

describe("barre latérale : « Exemples de la suite »", () => {
  beforeEach(() => {
    window.location.hash = "#/";
    vi.spyOn(api.exemples, "list").mockResolvedValue([histoire(false)]);
    vi.spyOn(api.reports, "list").mockResolvedValue([]);
  });
  afterEach(() => vi.restoreAllMocks());

  it("l'entrée est au pied de la barre, sous la navigation, et garde son nom en rail d'icônes", () => {
    const { rerender } = render(<Sidebar route={{ name: "reports" }} compact={false} />);
    const button = screen.getByRole("button", { name: "Exemples de la suite" });
    const nav = screen.getByRole("navigation", { name: "Navigation principale" });
    expect(nav.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(nav.contains(button)).toBe(false);
    expect(button.parentElement?.className).toMatch(/\bmt-auto\b/);
    expect(button).toHaveTextContent("Exemples de la suite");
    // Rail (Studio, ou sous 1024 px) : icône seule, nom accessible et info-bulle.
    rerender(<Sidebar route={{ name: "studio", id: "aaaaaaaaaaaa" }} compact />);
    const rail = screen.getByRole("button", { name: "Exemples de la suite" });
    expect(rail).toHaveTextContent("");
    expect(rail).toHaveAttribute("title", "Exemples de la suite");
    expect(rail).toHaveAttribute("aria-haspopup", "dialog");
  });

  it("ouvre un dialogue modal qui retient le focus, se ferme par Échap et rend le focus au bouton", async () => {
    render(<Sidebar route={{ name: "reports" }} compact={false} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    const { button, dialog } = await open();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog.contains(document.activeElement)).toBe(true);
    // Le contenu est celui de l'accueil : histoire, parcours, étape de Viz, action.
    expect(await within(dialog).findByRole("button", { name: "Charger l'exemple" })).toBeInTheDocument();
    expect(within(dialog).getByRole("combobox", { name: "Histoire d'exemple" })).toHaveValue("studio-garance");
    expect(within(dialog).getByText("Le poste Matériel dépasse : l'alerte se déclenche.")).toBeInTheDocument();
    expect(within(dialog).getAllByRole("heading", { name: "Exemples de la suite" })).toHaveLength(1);

    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(button).toHaveFocus();

    await open();
    await userEvent.click(screen.getByRole("button", { name: "Fermer" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it("charge l'histoire, crée son rapport, l'ouvre et ferme le dialogue", async () => {
    const load = vi.spyOn(api.exemples, "load").mockResolvedValue(charge);
    vi.spyOn(api.reports, "create").mockResolvedValue({ id: "cccccccccccc", name: charge.rapport } as unknown as Report);
    vi.spyOn(api.datasets, "get").mockResolvedValue(profile);
    const save = vi.spyOn(api.reports, "save").mockResolvedValue({} as unknown as Report);
    const changed = vi.fn();
    window.addEventListener(EXAMPLES_EVENT, changed);

    render(<Sidebar route={{ name: "data" }} compact={false} />);
    const { dialog } = await open();
    await userEvent.click(await within(dialog).findByRole("button", { name: "Charger l'exemple" }));

    await waitFor(() => expect(window.location.hash).toBe("#/rapports/cccccccccccc"));
    expect(load).toHaveBeenCalledWith("studio-garance");
    expect(save).toHaveBeenCalledWith("cccccccccccc", expect.objectContaining({ name: "Exemple — Studio Garance" }));
    expect(changed).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    window.removeEventListener(EXAMPLES_EVENT, changed);
  });

  it("rouvre le rapport déjà créé au lieu d'en faire un second", async () => {
    vi.spyOn(api.exemples, "list").mockResolvedValue([histoire(true)]);
    vi.spyOn(api.exemples, "load").mockResolvedValue(charge);
    vi.spyOn(api.reports, "list").mockResolvedValue([{ id: "dddddddddddd", name: charge.rapport }] as unknown as ReportSummary[]);
    const create = vi.spyOn(api.reports, "create");
    render(<Sidebar route={{ name: "settings" }} compact={false} />);
    const { dialog } = await open();
    await userEvent.click(await within(dialog).findByRole("button", { name: "Ouvrir le rapport de l'exemple" }));
    await waitFor(() => expect(window.location.hash).toBe("#/rapports/dddddddddddd"));
    expect(create).not.toHaveBeenCalled();
  });

  it("retire l'histoire : l'annonce part, et le rapport supprimé ouvert dans le Studio rend la main à l'accueil", async () => {
    const list = vi.spyOn(api.exemples, "list").mockResolvedValue([histoire(true)]);
    const remove = vi.spyOn(api.exemples, "remove").mockImplementation(async () => {
      list.mockResolvedValue([histoire(false)]);
    });
    vi.spyOn(api.reports, "list").mockResolvedValue([]);
    const changed = vi.fn();
    window.addEventListener(EXAMPLES_EVENT, changed);
    window.location.hash = "#/rapports/dddddddddddd";

    render(<Sidebar route={{ name: "studio", id: "dddddddddddd" }} compact />);
    const { dialog } = await open();
    await userEvent.click(await within(dialog).findByRole("button", { name: "Retirer l'exemple" }));

    expect(remove).toHaveBeenCalledWith("studio-garance");
    expect(await within(dialog).findByRole("button", { name: "Charger l'exemple" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Retirer l'exemple" })).not.toBeInTheDocument();
    expect(changed).toHaveBeenCalled();
    await waitFor(() => expect(window.location.hash).toBe("#/"));
    window.removeEventListener(EXAMPLES_EVENT, changed);
  });

  it("dit qu'il lit, puis qu'il n'a pas pu lire, au lieu d'un dialogue vide", async () => {
    const list = vi.spyOn(api.exemples, "list").mockRejectedValue(new Error("hors service"));
    render(<Sidebar route={{ name: "reports" }} compact={false} />);
    const { dialog } = await open();
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Les exemples n'ont pas pu être lus.");
    list.mockResolvedValue([]);
    await userEvent.click(within(dialog).getByRole("button", { name: "Réessayer" }));
    expect(await within(dialog).findByText("Aucun exemple n'est livré avec cette installation.")).toBeInTheDocument();
  });
});
