import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Page, Report } from "../types/report";
import { Canvas } from "./Canvas";
import { PageTabs } from "./PageTabs";
import { useStudio } from "./store";

vi.mock("./VisualContainer", () => ({ VisualContainer: () => <div data-testid="visuel" /> }));

const page: Page = { id: "p1", name: "Page 1", size: { width: 1280, height: 720 }, filters: [], visuals: [] };
const report = { id: "r1", name: "Rapport", dataset_id: null, theme: {}, pages: [page] } as unknown as Report;

/** Place de la zone de défilement du canvas (jsdom ne met rien en page) et observateur de taille déclenchable. */
let place = { width: 1452, height: 602 };
let observers: (() => void)[] = [];

function resize(width: number, height: number) {
  place = { width, height };
  act(() => observers.forEach((notify) => notify()));
}

const frame = () => document.querySelector<HTMLElement>("[data-page-frame]")!;
const zoomShown = () => within(screen.getByRole("group", { name: "Zoom" })).getByTitle("Taille réelle (100 %)").textContent;

describe("zoom du canvas : ajusté à la place disponible", () => {
  beforeEach(() => {
    place = { width: 1452, height: 602 };
    observers = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private readonly notify: () => void) {}
        observe() {
          observers.push(this.notify);
        }
        disconnect() {
          observers = observers.filter((n) => n !== this.notify);
        }
        unobserve() {}
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => place.width);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => place.height);
    useStudio.setState({ mode: "view", report, pageId: "p1", selectedId: null });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    useStudio.setState({ mode: "edit", report: null });
  });

  function open() {
    return render(
      <div>
        <Canvas page={page} report={report} />
        <PageTabs />
      </div>,
    );
  }

  it("à l'ouverture, la page entière tient dans la place : rien n'est coupé en bas", () => {
    open();
    // 1452 × 602 (écran de 1500 × 730 en lecture) : la hauteur borne, 76 % ; à la largeur seule, 110 %.
    expect(zoomShown()).toBe("77 %");
    expect(parseFloat(frame().style.height)).toBeLessThanOrEqual(602 - 48);
    expect(parseFloat(frame().style.width)).toBeLessThanOrEqual(1452 - 48);
    expect(screen.getByRole("button", { name: /Ajuster$/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("le contrôle de zoom se range dans la barre des pages : il ne recouvre pas la page", () => {
    open();
    const bar = screen.getByRole("navigation", { name: "Pages du rapport" }).parentElement!;
    expect(within(bar).getByRole("group", { name: "Zoom" })).toBeInTheDocument();
    // Plus de marge basse réservée à un contrôle flottant.
    expect(frame().parentElement!.style.paddingBottom).toBe("24px");
  });

  it("un volet qui s'ouvre ou se replie, une fenêtre qui change : la page se réajuste", () => {
    open();
    // Volets d'édition ouverts (940 px) : la largeur borne.
    resize(940, 602);
    expect(zoomShown()).toBe("70 %");
    expect(parseFloat(frame().style.width)).toBeLessThanOrEqual(940 - 48);
    // Fenêtre plus basse (1366 × 650).
    resize(1318, 522);
    expect(zoomShown()).toBe("66 %");
    expect(parseFloat(frame().style.height)).toBeLessThanOrEqual(522 - 48);
    // Retour à la grande place.
    resize(1452, 602);
    expect(zoomShown()).toBe("77 %");
  });

  it("un zoom choisi à la main reste quand la place change ; « Ajuster » revient à l'ajustement automatique", async () => {
    open();
    await userEvent.click(screen.getByRole("button", { name: "Zoom avant" }));
    expect(zoomShown()).toBe("100 %");
    expect(screen.getByRole("button", { name: /Ajuster$/ })).toHaveAttribute("aria-pressed", "false");
    resize(940, 602);
    expect(zoomShown()).toBe("100 %");
    await userEvent.click(screen.getByRole("button", { name: /Ajuster$/ }));
    expect(zoomShown()).toBe("70 %");
    resize(1452, 602);
    expect(zoomShown()).toBe("77 %");
  });

  it("« Ajuster à la largeur » garde l'ancien comportement : toute la largeur, le bas en défilant", async () => {
    open();
    await userEvent.click(screen.getByRole("button", { name: "Ajuster à la largeur" }));
    expect(zoomShown()).toBe("110 %");
    expect(screen.getByRole("button", { name: "Ajuster à la largeur" })).toHaveAttribute("aria-pressed", "true");
    resize(940, 602);
    expect(zoomShown()).toBe("70 %");
  });

  it("sans barre des pages (canvas seul), le contrôle flotte et la page lui laisse sa place", () => {
    render(<Canvas page={page} report={report} />);
    expect(screen.getByRole("group", { name: "Zoom" })).toBeInTheDocument();
    expect(frame().parentElement!.style.paddingBottom).toBe("56px");
    expect(parseFloat(frame().style.height)).toBeLessThanOrEqual(602 - 48 - 32);
  });
});
