import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { useModalFocus } from "../hooks/useModalFocus";
import { ContextMenu, type MenuItem } from "./ContextMenu";

function Harness({ items }: { items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Exporter
      </button>
      <button type="button">Présenter</button>
      {open && <ContextMenu x={10} y={10} title="Exporter" items={items} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Dialogue modal dont le dernier bouton ouvre un menu (présentation : clic droit, menus des visuels). */
function ModalHarness() {
  const ref = useModalFocus<HTMLDivElement>();
  const [open, setOpen] = useState(false);
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label="Présentation">
      <button type="button">Précédent</button>
      <button type="button" onClick={() => setOpen(true)}>
        Options
      </button>
      {open && <ContextMenu x={10} y={10} items={items()} onClose={() => setOpen(false)} />}
    </div>
  );
}

const items = (onSelect: (label: string) => void = () => undefined): MenuItem[] => [
  { label: "PowerPoint", onSelect: () => onSelect("pptx") },
  { label: "Indisponible", disabled: true },
  { label: "PDF", onSelect: () => onSelect("pdf") },
  { label: "Image", onSelect: () => onSelect("png") },
];

describe("ContextMenu au clavier", () => {
  it("les flèches, Début et Fin parcourent les entrées actives, en boucle", async () => {
    render(<Harness items={items()} />);
    await userEvent.click(screen.getByRole("button", { name: "Exporter" }));
    expect(screen.getByRole("menuitem", { name: "PowerPoint" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "PDF" })).toHaveFocus();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "PowerPoint" })).toHaveFocus();
    await userEvent.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitem", { name: "Image" })).toHaveFocus();
    await userEvent.keyboard("{Home}");
    expect(screen.getByRole("menuitem", { name: "PowerPoint" })).toHaveFocus();
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("menuitem", { name: "Image" })).toHaveFocus();
  });

  it.each(["{Escape}", "{Tab}"])("%s ferme le menu et rend le focus au bouton qui l'a ouvert", async (key) => {
    render(<Harness items={items()} />);
    const opener = screen.getByRole("button", { name: "Exporter" });
    await userEvent.click(opener);
    await userEvent.keyboard(key);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("un choix rend le focus au déclencheur avant de lancer l'action", async () => {
    const focused: (string | null)[] = [];
    const onSelect = vi.fn(() => focused.push(document.activeElement?.textContent ?? null));
    render(<Harness items={items(onSelect)} />);
    await userEvent.click(screen.getByRole("button", { name: "Exporter" }));
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenCalledWith("pdf");
    expect(focused).toEqual(["Exporter"]);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("les touches de parcours ne remontent pas aux raccourcis de la page (flèches du Studio)", async () => {
    const pageKeys: string[] = [];
    const onKey = (e: KeyboardEvent) => pageKeys.push(e.key);
    window.addEventListener("keydown", onKey);
    try {
      render(<Harness items={items()} />);
      await userEvent.click(screen.getByRole("button", { name: "Exporter" }));
      await userEvent.keyboard("{ArrowDown}{ArrowUp}{Home}{End}");
      expect(screen.getByRole("menuitem", { name: "Image" })).toHaveFocus();
      expect(pageKeys).toEqual([]);
    } finally {
      window.removeEventListener("keydown", onKey);
    }
  });

  it("dans un dialogue modal, Tab ferme le menu et laisse le focus au déclencheur (pas de saut au premier élément)", async () => {
    render(<ModalHarness />);
    const opener = screen.getByRole("button", { name: "Options" });
    await userEvent.click(opener);
    expect(screen.getByRole("menuitem", { name: "PowerPoint" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });
});
