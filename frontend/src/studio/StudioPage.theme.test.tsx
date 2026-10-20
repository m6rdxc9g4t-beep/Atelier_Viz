import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetPreferencesCache } from "../hooks/usePreferences";
import { resetProvidersCache } from "../hooks/useProviders";
import { api } from "../lib/api";
import type { Report } from "../types/report";
import { StudioPage } from "./StudioPage";

// Le canvas (visuels, requêtes) n'est pas l'objet du test : seule compte la place des volets.
vi.mock("./Canvas", () => ({ Canvas: () => <div data-testid="canvas" /> }));

const report = {
  id: "r-theme",
  name: "Thème sombre",
  dataset_id: "ds1",
  theme: { mode: "dark", preset: "midnight", page: "#0b1220", accent: "#3987e5" },
  pages: [{ id: "p1", name: "Page 1", size: { width: 1280, height: 720 }, visuals: [], filters: [] }],
} as unknown as Report;

describe("thème du rapport : la page seulement, jamais les volets", () => {
  beforeEach(() => {
    resetPreferencesCache();
    resetProvidersCache();
    vi.spyOn(api.reports, "get").mockResolvedValue(structuredClone(report));
    vi.spyOn(api.datasets, "list").mockResolvedValue([]);
    vi.spyOn(api.datasets, "get").mockRejectedValue(new Error("absent"));
    vi.spyOn(api.settings, "get").mockResolvedValue({ online_mode: false, ai_provider: "auto", claude_model: "sonnet", ollama_model: null });
    vi.spyOn(api, "providers").mockResolvedValue({ providers: [] });
  });
  afterEach(() => vi.restoreAllMocks());

  it("les variables et data-theme du rapport sont posés sur la page ; les volets (dont « Créer avec l'IA ») restent hors de cette racine", async () => {
    render(<StudioPage reportId="r-theme" />);
    const page = await screen.findByRole("region", { name: /^Page Page 1/ });
    expect(page).toHaveAttribute("data-theme", "dark");
    expect(page.className).toContain("theme-dark");
    expect(page.style.getPropertyValue("--accent")).toBe("#3987e5");
    // L'encre héritée dans la page vient du thème du rapport (et non de <body>, au thème de l'application).
    expect(page.className).toContain("text-fg");

    const outsidePage = () => {
      const panes = document.querySelectorAll("aside");
      expect(panes.length).toBeGreaterThan(0);
      panes.forEach((pane) => {
        expect(page.contains(pane)).toBe(false);
        expect(pane.closest("[data-theme], .theme-dark, .theme-light, [style*='--accent']")).toBeNull();
      });
    };
    outsidePage();
    await userEvent.click(screen.getByRole("button", { name: /Créer avec l'IA/ }));
    expect(screen.getByRole("complementary", { name: "Créer avec l'IA" })).toBeInTheDocument();
    outsidePage();
  });
});
