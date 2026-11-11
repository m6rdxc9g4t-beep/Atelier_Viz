import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetPreferencesCache } from "../hooks/usePreferences";
import { resetProvidersCache } from "../hooks/useProviders";
import { ApiError, api } from "../lib/api";
import type { Report } from "../types/report";
import { StudioPage } from "./StudioPage";
import { useStudio } from "./store";

vi.mock("./Canvas", () => ({ Canvas: () => <div data-testid="canvas" /> }));

const report = {
  id: "r-auto",
  name: "Ventes",
  dataset_id: "ds1",
  theme: {},
  pages: [{ id: "p1", name: "Page 1", size: { width: 1280, height: 720 }, visuals: [], filters: [] }],
} as unknown as Report;

/** Ouvre le rapport, puis fige l'horloge : les délais d'enregistrement s'avancent à la main. */
async function openStudio() {
  render(<StudioPage reportId="r-auto" />);
  const name = await screen.findByRole("textbox", { name: "Nom du rapport" });
  vi.useFakeTimers();
  return name;
}

describe("enregistrement automatique du Studio", () => {
  beforeEach(() => {
    resetPreferencesCache();
    resetProvidersCache();
    useStudio.setState({ mode: "edit", report: null, saveState: "saved" });
    vi.spyOn(api.reports, "get").mockResolvedValue(structuredClone(report));
    vi.spyOn(api.datasets, "list").mockResolvedValue([]);
    vi.spyOn(api.datasets, "get").mockRejectedValue(new Error("absent"));
    vi.spyOn(api.settings, "get").mockResolvedValue({ online_mode: false, ai_provider: "auto", claude_model: "sonnet", ollama_model: null });
    vi.spyOn(api, "providers").mockResolvedValue({ providers: [] });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    useStudio.setState({ mode: "edit", report: null, saveState: "saved" });
  });

  it("fenêtre fermée avant la fin de la pause : la modification part tout de suite, une seule fois", async () => {
    const save = vi.spyOn(api.reports, "save").mockResolvedValue(report);
    const name = await openStudio();
    fireEvent.change(name, { target: { value: "Ventes 2026" } });
    expect(save).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("pagehide"));
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("r-auto", expect.objectContaining({ name: "Ventes 2026" }), true);

    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("rien à envoyer à la fermeture quand tout est enregistré", async () => {
    const save = vi.spyOn(api.reports, "save").mockResolvedValue(report);
    await openStudio();
    window.dispatchEvent(new Event("pagehide"));
    expect(save).not.toHaveBeenCalled();
  });

  it("serveur injoignable : l'enregistrement est retenté seul, sans nouvelle modification", async () => {
    const save = vi.spyOn(api.reports, "save").mockRejectedValueOnce(new ApiError(0, "Le serveur local ne répond pas.")).mockResolvedValue(report);
    const name = await openStudio();
    fireEvent.change(name, { target: { value: "Ventes 2026" } });
    await act(() => vi.advanceTimersByTimeAsync(800));
    expect(save).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Échec de l'enregistrement")).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith("r-auto", expect.objectContaining({ name: "Ventes 2026" }));
    expect(screen.getByText("Enregistré")).toBeInTheDocument();
  });

  it("refus du serveur : pas de nouvel essai en boucle", async () => {
    const save = vi.spyOn(api.reports, "save").mockRejectedValue(new ApiError(422, "Rapport invalide."));
    const name = await openStudio();
    fireEvent.change(name, { target: { value: "Ventes 2026" } });
    await act(() => vi.advanceTimersByTimeAsync(800));
    await act(() => vi.advanceTimersByTimeAsync(20000));
    expect(save).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Échec de l'enregistrement")).toBeInTheDocument();
  });
});
