import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";

import { useModalFocus } from "./useModalFocus";

function Dialog({ onClose, children, auto = false }: { onClose: () => void; children?: React.ReactNode; auto?: boolean }) {
  const ref = useModalFocus<HTMLDivElement>();
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label="Exporter">
      <button type="button" onClick={onClose}>
        Fermer
      </button>
      <input aria-label="Nom" autoFocus={auto} />
      <button type="button" disabled>
        Indisponible
      </button>
      <input type="file" tabIndex={-1} aria-label="Fichier caché" />
      <button type="button">Valider</button>
      {children}
    </div>
  );
}

function Page({ auto = false, nested = false }: { auto?: boolean; nested?: boolean }) {
  const [open, setOpen] = useState(false);
  const [inner, setInner] = useState(false);
  return (
    <>
      <button type="button">Avant</button>
      <button type="button" onClick={() => setOpen(true)}>
        Ouvrir
      </button>
      <button type="button">Après</button>
      {open && (
        <Dialog auto={auto} onClose={() => setOpen(false)}>
          {nested && (
            <button type="button" onClick={() => setInner(true)}>
              Détails
            </button>
          )}
          {inner && (
            <div>
              <InnerDialog onClose={() => setInner(false)} />
            </div>
          )}
        </Dialog>
      )}
    </>
  );
}

function InnerDialog({ onClose }: { onClose: () => void }) {
  const ref = useModalFocus<HTMLDivElement>();
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label="Détails">
      <button type="button" onClick={onClose}>
        Retour
      </button>
      <button type="button">Copier</button>
    </div>
  );
}

describe("useModalFocus", () => {
  it("fait entrer le focus dans le dialogue à l'ouverture", async () => {
    render(<Page />);
    await userEvent.click(screen.getByRole("button", { name: "Ouvrir" }));
    expect(screen.getByRole("dialog", { name: "Exporter" })).toHaveFocus();
  });

  it("laisse le focus au champ choisi par le dialogue (autoFocus)", async () => {
    render(<Page auto />);
    await userEvent.click(screen.getByRole("button", { name: "Ouvrir" }));
    expect(screen.getByRole("textbox", { name: "Nom" })).toHaveFocus();
  });

  it("Tab et Maj+Tab bouclent dans le dialogue, sans passer par les éléments désactivés ou hors tabulation", async () => {
    render(<Page />);
    await userEvent.click(screen.getByRole("button", { name: "Ouvrir" }));
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Fermer" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("textbox", { name: "Nom" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Valider" })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Fermer" })).toHaveFocus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Valider" })).toHaveFocus();
  });

  it("rend le focus au bouton qui a ouvert le dialogue", async () => {
    render(<Page />);
    const opener = screen.getByRole("button", { name: "Ouvrir" });
    await userEvent.click(opener);
    await userEvent.click(screen.getByRole("button", { name: "Fermer" }));
    expect(opener).toHaveFocus();
  });

  it("deux dialogues empilés : seul celui du dessus retient le focus, puis le rend au premier", async () => {
    render(<Page nested />);
    await userEvent.click(screen.getByRole("button", { name: "Ouvrir" }));
    const details = screen.getByRole("button", { name: "Détails" });
    await userEvent.click(details);
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Retour" })).toHaveFocus();
    await userEvent.tab();
    await userEvent.tab();
    expect(screen.getByRole("button", { name: "Retour" })).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Retour" }));
    expect(details).toHaveFocus();
  });
});
