import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetPreferencesCache } from "../hooks/usePreferences";
import { resetProvidersCache } from "../hooks/useProviders";
import { api } from "../lib/api";
import { NARROW_QUERY } from "../lib/viewport";
import type { Report } from "../types/report";
import { StudioPage } from "./StudioPage";
import { useStudio } from "./store";

vi.mock("./Canvas", () => ({ Canvas: () => <div data-testid="canvas" /> }));

const report = {
  id: "r-etroit",
  name: "Ventes",
  dataset_id: "ds1",
  theme: {},
  pages: [{ id: "p1", name: "Page 1", size: { width: 1280, height: 720 }, visuals: [], filters: [] }],
} as unknown as Report;

/** Simule la largeur de l'écran : seule la requête « écran étroit » répond. */
function screenWidth(narrow: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: narrow && query === NARROW_QUERY, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
}

describe("Studio sur un écran étroit (téléphone)", () => {
  beforeEach(() => {
    resetPreferencesCache();
    resetProvidersCache();
    useStudio.setState({ mode: "edit", report: null });
    vi.spyOn(api.reports, "get").mockResolvedValue(structuredClone(report));
    vi.spyOn(api.datasets, "list").mockResolvedValue([]);
    vi.spyOn(api.datasets, "get").mockRejectedValue(new Error("absent"));
    vi.spyOn(api.settings, "get").mockResolvedValue({ online_mode: false, ai_provider: "auto", claude_model: "sonnet", ollama_model: null });
    vi.spyOn(api, "providers").mockResolvedValue({ providers: [] });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    useStudio.setState({ mode: "edit", report: null });
  });

  it("le rapport s'ouvre en lecture : la page n'est pas masquée par les volets d'édition", async () => {
    screenWidth(true);
    render(<StudioPage reportId="r-etroit" />);
    await screen.findByRole("region", { name: /^Page Page 1/ });
    expect(screen.getByRole("button", { name: "Lecture" })).toHaveAttribute("aria-pressed", "true");
    expect(document.querySelectorAll("aside")).toHaveLength(0);
  });

  it("en édition, les volets s'ouvrent repliés et se déplient à la demande", async () => {
    screenWidth(true);
    render(<StudioPage reportId="r-etroit" />);
    await screen.findByRole("region", { name: /^Page Page 1/ });
    await userEvent.click(screen.getByRole("button", { name: "Édition" }));
    expect(document.querySelectorAll("aside")).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Ouvrir le volet Visualisations" }));
    expect(screen.getByRole("complementary", { name: "Visualisations" })).toBeInTheDocument();
  });

  it("sur un grand écran, rien ne change : édition, volets ouverts", async () => {
    screenWidth(false);
    render(<StudioPage reportId="r-etroit" />);
    await screen.findByRole("region", { name: /^Page Page 1/ });
    expect(screen.getByRole("button", { name: "Édition" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("complementary", { name: "Visualisations" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Données" })).toBeInTheDocument();
  });
});
