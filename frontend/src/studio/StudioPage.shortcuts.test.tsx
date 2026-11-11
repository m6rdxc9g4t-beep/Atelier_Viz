import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetPreferencesCache } from "../hooks/usePreferences";
import { resetProvidersCache } from "../hooks/useProviders";
import { api } from "../lib/api";
import type { Report } from "../types/report";
import { StudioPage } from "./StudioPage";
import { useStudio } from "./store";

vi.mock("./Canvas", () => ({ Canvas: () => <div data-testid="canvas" /> }));

const report = {
  id: "r-keys",
  name: "Ventes",
  dataset_id: "ds1",
  theme: {},
  pages: [
    {
      id: "p1",
      name: "Page 1",
      size: { width: 1280, height: 720 },
      filters: [],
      visuals: [{ id: "v1", type: "line", title: "Courbe", layout: { x: 40, y: 180, w: 400, h: 240 }, dataset_id: "ds1", roles: {}, options: {}, filters: [] }],
    },
  ],
} as unknown as Report;

const visual = () => useStudio.getState().report?.pages[0]?.visuals.find((v) => v.id === "v1");

/** Ouvre le rapport en édition, visuel sélectionné, puis fige l'horloge (l'enregistrement s'avance à la main). */
async function openStudio() {
  render(<StudioPage reportId="r-keys" />);
  await screen.findByRole("textbox", { name: "Nom du rapport" });
  act(() => useStudio.getState().select("v1"));
  vi.useFakeTimers();
}

/** Touche tapée sur l'élément qui a le focus, comme au clavier. */
const press = (key: string) => fireEvent.keyDown(document.activeElement ?? document.body, { key });

describe("raccourcis clavier du Studio", () => {
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

  it("hors d'un menu, les flèches déplacent le visuel sélectionné", async () => {
    const save = vi.spyOn(api.reports, "save").mockResolvedValue(report);
    await openStudio();
    press("ArrowDown");
    expect(visual()?.layout).toMatchObject({ x: 40, y: 181 });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("dans le menu « Exporter », les flèches parcourent les entrées sans déplacer le visuel ni modifier le rapport", async () => {
    const save = vi.spyOn(api.reports, "save").mockResolvedValue(report);
    await openStudio();
    fireEvent.click(screen.getByRole("button", { name: "Exporter" }));
    const entries = within(screen.getByRole("menu")).getAllByRole("menuitem");
    expect(entries[0]).toHaveFocus();
    expect(useStudio.getState().selectedId).toBe("v1");

    for (let i = 0; i < 5; i += 1) press("ArrowDown");
    press("ArrowUp");
    press("End");
    expect(entries[entries.length - 1]).toHaveFocus();
    press("Home");
    expect(entries[0]).toHaveFocus();
    expect(visual()?.layout).toEqual({ x: 40, y: 180, w: 400, h: 240 });

    // Les autres raccourcis du Studio ne traversent pas le menu non plus.
    press("ArrowRight");
    press("Delete");
    press("Backspace");
    expect(visual()?.layout).toEqual({ x: 40, y: 180, w: 400, h: 240 });

    // Échap ferme le menu, le visuel reste sélectionné.
    press("Escape");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(useStudio.getState().selectedId).toBe("v1");

    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(save).not.toHaveBeenCalled();
    expect(useStudio.getState().saveState).toBe("saved");
  });

  it("une touche tapée dans un dialogue ne touche pas au visuel sélectionné derrière", async () => {
    await openStudio();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const button = document.createElement("button");
    dialog.append(button);
    document.body.append(dialog);
    try {
      button.focus();
      press("ArrowDown");
      press("Delete");
      expect(visual()?.layout).toEqual({ x: 40, y: 180, w: 400, h: 240 });
    } finally {
      dialog.remove();
    }
  });
});
