import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetPreferencesCache } from "../../hooks/usePreferences";
import { resetProvidersCache } from "../../hooks/useProviders";
import { api } from "../../lib/api";
import type { BuildResponse, ProposedVisual, RepairRequest } from "../../types/builder";
import type { ColumnProfile, DatasetProfile } from "../../types/dataset";
import type { Report } from "../../types/report";
import { useAIBuilder } from "../aiBuilder";
import { StudioDataContext } from "../context";
import { useStudio } from "../store";
import { AIBuilderPane } from "./AIBuilderPane";

const col = (name: string, type: ColumnProfile["type"], distinct: number): ColumnProfile => ({
  name,
  type,
  nulls: 0,
  distinct,
  min: null,
  max: null,
  mean: null,
  top_values: [],
});

const profile = {
  id: "ds1",
  name: "ventes_2026.csv",
  columns: [col("date", "date", 300), col("region", "string", 5), col("produit", "string", 4), col("chiffre_affaires", "number", 900)],
  sample: [],
} as unknown as DatasetProfile;

const proposal = (title: string): ProposedVisual => ({
  type: "bar",
  title,
  roles: { category: [{ field: "produit" }], values: [{ field: "chiffre_affaires", agg: "sum" }] },
  options: {},
});

const response = (...titles: string[]): BuildResponse => ({
  visuals: titles.map(proposal),
  explanation: "Un classement.",
  provider: "anthropic",
  model: "sonnet",
  warnings: [],
});

const report: Report = {
  id: "r1",
  name: "Ventes",
  pages: [{ id: "p1", name: "Page 1", size: { width: 1280, height: 720 }, visuals: [], filters: [] }],
} as unknown as Report;

function renderPane() {
  return render(
    <StudioDataContext.Provider value={{ datasets: [], profiles: new Map([["ds1", profile]]), activeDatasetId: "ds1", setActiveDatasetId: () => {} }}>
      <AIBuilderPane />
    </StudioDataContext.Provider>,
  );
}

describe("volet « Créer avec l'IA »", () => {
  beforeEach(() => {
    resetPreferencesCache();
    resetProvidersCache();
    useAIBuilder.setState({ sessions: {} });
    useStudio.getState().load(structuredClone(report));
    vi.spyOn(api.settings, "get").mockResolvedValue({ online_mode: true, ai_provider: "auto", claude_model: "sonnet", ollama_model: null });
    vi.spyOn(api, "providers").mockResolvedValue({
      providers: [
        { name: "ollama", available: true, model: "llama3.2", detail: null, models: ["llama3.2:latest"] },
        { name: "anthropic", available: true, model: "sonnet (CLI)", detail: null, models: ["sonnet", "opus", "haiku"] },
      ],
    });
    // repair renvoie les visuels tels quels, titre marqué pour vérifier qu'ils sont bien passés par là.
    vi.spyOn(api, "repairVisuals").mockImplementation(async (body: RepairRequest) => ({
      results: body.visuals.map((v) => ({ visual: { ...v, title: `${v.title} ✓` }, warnings: [], errors: [] })),
    }));
  });
  afterEach(() => vi.restoreAllMocks());

  it("suggestions toujours accessibles, nouvelle demande, historique et réajout après Ctrl+Z", async () => {
    const user = userEvent.setup();
    const build = vi
      .spyOn(api, "buildVisuals")
      .mockResolvedValueOnce(response("Top 5 des produits"))
      .mockResolvedValueOnce(response("CA par région", "CA par mois"));
    renderPane();

    // Départ : suggestions ouvertes ; un clic génère comme avant.
    const toggle = screen.getByRole("button", { name: /Suggestions \(4\)/ });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("button", { name: "Top 5 des produit par chiffre_affaires" }));
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ prompt: "Top 5 des produit par chiffre_affaires", provider: "auto" }), expect.any(AbortSignal));
    expect(await screen.findByText("1 proposition · Claude")).toBeInTheDocument();

    // Après génération : suggestions repliées mais toujours là.
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(screen.getByRole("button", { name: "Tableau croisé produit × region" })).toBeInTheDocument();

    // Ajout : passe par repair, puis Ctrl+Z → « Réajouter ».
    await user.click(screen.getByRole("button", { name: "Ajouter Top 5 des produits" }));
    expect(api.repairVisuals).toHaveBeenCalledWith(expect.objectContaining({ dataset_id: "ds1", visuals: [proposal("Top 5 des produits")] }));
    expect(useStudio.getState().report?.pages[0]?.visuals.map((v) => v.title)).toEqual(["Top 5 des produits ✓"]);
    expect(screen.getByRole("button", { name: "Top 5 des produits : ajouté" })).toBeDisabled();
    act(() => useStudio.getState().undo());
    expect(useStudio.getState().report?.pages[0]?.visuals).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Ajouter Top 5 des produits de nouveau" })).toBeEnabled();

    // Nouvelle demande : zone vide, résultat retiré, suggestions rouvertes, historique d'une entrée.
    await user.click(screen.getByRole("button", { name: /Nouvelle demande/ }));
    expect(screen.getByRole("textbox", { name: "Décrivez le visuel à créer" })).toHaveValue("");
    expect(screen.queryByText("1 proposition · Claude")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Suggestions \(4\)/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: /Demandes précédentes \(1\)/ })).toBeInTheDocument();

    // Deuxième génération ; la première reste consultable et réajoutable.
    await user.type(screen.getByRole("textbox", { name: "Décrivez le visuel à créer" }), "CA par région et par mois");
    await user.click(screen.getByRole("button", { name: /Générer/ }));
    expect(await screen.findByText("2 propositions · Claude")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Demandes précédentes \(1\)/ }));
    const item = screen.getByRole("button", { name: /Top 5 des produit par chiffre_affaires/ });
    await user.click(item);
    const history = item.closest("li") as HTMLElement;
    await user.click(within(history).getByRole("button", { name: "Ajouter Top 5 des produits de nouveau" }));
    expect(useStudio.getState().report?.pages[0]?.visuals.map((v) => v.title)).toEqual(["Top 5 des produits ✓"]);
    expect(within(history).getByRole("button", { name: "Top 5 des produits : ajouté" })).toBeDisabled();
    expect(within(history).getByText(/1 sur la page/)).toBeInTheDocument();

    // Le volet fermé puis rouvert garde tout (session par rapport).
    renderPane().unmount();
    expect(useAIBuilder.getState().sessions.r1?.entries).toHaveLength(2);
  });

  it("un visuel devenu invalide (colonne supprimée) n'est pas ajouté et la raison est affichée", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "buildVisuals").mockResolvedValueOnce(response("Top 5 des produits"));
    vi.mocked(api.repairVisuals).mockResolvedValueOnce({ results: [{ visual: null, warnings: [], errors: ["rôle(s) obligatoire(s) manquant(s) : Valeurs."] }] });
    renderPane();
    await user.type(screen.getByRole("textbox", { name: "Décrivez le visuel à créer" }), "Top produits");
    await user.click(screen.getByRole("button", { name: /Générer/ }));
    await user.click(await screen.findByRole("button", { name: "Ajouter Top 5 des produits" }));
    expect(useStudio.getState().report?.pages[0]?.visuals).toHaveLength(0);
    expect(screen.getByRole("status")).toHaveTextContent("manquant(s) : Valeurs");
  });
});
