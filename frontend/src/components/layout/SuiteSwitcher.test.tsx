import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SuiteSwitcher } from "./SuiteSwitcher";

describe("sélecteur « Suite Atelier »", () => {
  const open = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    vi.spyOn(window, "open").mockImplementation((...args) => {
      open(...args);
      return null;
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    open.mockReset();
  });

  it("ouvre un menu accessible, coche Atelier Viz et indique l'état des trois applications", async () => {
    render(<SuiteSwitcher />);
    const button = screen.getByRole("button", { name: "Suite Atelier" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(button);
    expect(button).toHaveAttribute("aria-expanded", "true");
    const items = screen.getAllByRole("menuitemradio");
    // Affichage dans la marque commune (« atelier_Viz »), noms accessibles inchangés (docs/SUITE.md §3).
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining("atelier_Viz"),
      expect.stringContaining("atelier_Tab"),
      expect.stringContaining("atelier_Projets"),
    ]);
    expect(items.map((i) => i.getAttribute("aria-label"))).toEqual([
      expect.stringContaining("Atelier Viz"),
      expect.stringContaining("Atelier Tab"),
      expect.stringContaining("Atelier Projets"),
    ]);
    expect(items[0]).toHaveAttribute("aria-checked", "true");
    expect(items[0]).toHaveFocus();
    // fetch refusé (no-cors) : Projets et Tab sont « arrêtée », sans bloquer le menu ; Viz (la page) est en marche.
    expect(await screen.findByRole("menuitemradio", { name: "Atelier Projets (Arrêtée)" })).toBeInTheDocument();
    expect(await screen.findByRole("menuitemradio", { name: "Atelier Tab (Arrêtée)" })).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "Atelier Viz (En marche)" })).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:3000/api/health", expect.objectContaining({ mode: "no-cors" }));
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:4175/api/health", expect.objectContaining({ mode: "no-cors" }));
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:5175/api/health", expect.objectContaining({ mode: "no-cors" }));
    expect(fetch).not.toHaveBeenCalledWith("/api/health", expect.anything());
  });

  it("Atelier Tab « en marche » quand sa route de santé répond (app de bureau sur 4175)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => (url === "http://127.0.0.1:4175/api/health" ? Promise.resolve(new Response(null, { status: 200 })) : Promise.reject(new TypeError("Failed to fetch")))),
    );
    render(<SuiteSwitcher />);
    await userEvent.click(screen.getByRole("button", { name: "Suite Atelier" }));
    expect(await screen.findByRole("menuitemradio", { name: "Atelier Tab (En marche)" })).toBeInTheDocument();
    expect(await screen.findByRole("menuitemradio", { name: "Atelier Projets (Arrêtée)" })).toBeInTheDocument();
  });

  it("se pilote au clavier : flèches, Entrée ouvre l'application, Échap ferme", async () => {
    render(<SuiteSwitcher />);
    const button = screen.getByRole("button", { name: "Suite Atelier" });
    button.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitemradio", { name: /^Atelier Tab/ })).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(screen.getAllByRole("menuitemradio")[2]).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getAllByRole("menuitemradio")[0]).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(button).toHaveFocus();

    await userEvent.click(button);
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(open).toHaveBeenCalledWith("http://127.0.0.1:4175", "_blank", "noopener,noreferrer");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("se ferme sur un clic à l'extérieur ; l'application courante n'ouvre rien", async () => {
    render(
      <div>
        <SuiteSwitcher />
        <p>ailleurs</p>
      </div>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Suite Atelier" }));
    await act(async () => {
      fireEvent.pointerDown(screen.getByText("ailleurs"));
    });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Suite Atelier" }));
    await userEvent.click(screen.getAllByRole("menuitemradio")[0]!);
    expect(open).not.toHaveBeenCalled();
  });
});
