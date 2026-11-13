import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NARROW_QUERY, forgetScrollbarSize } from "../lib/viewport";
import type { Page, Report } from "../types/report";
import { Canvas } from "./Canvas";
import { PageTabs } from "./PageTabs";
import { useStudio } from "./store";
import { ZOOM_STORAGE_KEY, forgetZoom } from "./zoom";

vi.mock("./VisualContainer", () => ({ VisualContainer: () => <div data-testid="visuel" /> }));

const page: Page = { id: "p1", name: "Page 1", size: { width: 1280, height: 720 }, filters: [], visuals: [] };
const report = { id: "r1", name: "Rapport", dataset_id: null, theme: {}, pages: [page] } as unknown as Report;

/**
 * Boîte de la zone de défilement du canvas (jsdom ne met rien en page), épaisseur d'une barre de défilement
 * classique (0 : barres superposées) et observateur de taille déclenchable.
 */
let place = { width: 1452, height: 602 };
let scrollbar = 0;
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
    scrollbar = 0;
    observers = [];
    forgetZoom();
    forgetScrollbarSize();
    localStorage.removeItem(ZOOM_STORAGE_KEY);
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
    // La boîte (`offsetWidth`) ne dépend pas des barres ; la place utile (`clientWidth`) en perd l'épaisseur.
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(() => place.width);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(() => place.height);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => place.width - scrollbar);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => place.height);
    useStudio.setState({ mode: "view", report, pageId: "p1", selectedId: null });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    useStudio.setState({ mode: "edit", report: null });
  });

  function open(shown: Page = page, of: Report = report) {
    return render(
      <div>
        <Canvas page={shown} report={of} />
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

  it("barres de défilement de Windows (15 px) : la place se mesure sur la boîte, la page longue ne clignote pas", () => {
    // Page de 1280 × 1605, volets d'édition ouverts : au seuil où la page clignotait entre 35 % et 70 %.
    scrollbar = 15;
    place = { width: 940, height: 602 };
    open({ ...page, size: { width: 1280, height: 1605 } });
    // À la largeur, barre verticale déjà retirée : (940 − 48 − 15) / 1280.
    expect(zoomShown()).toBe("69 %");
    expect(parseFloat(frame().style.width)).toBeLessThanOrEqual(940 - 48 - 15);
    // La barre apparaît, l'observateur de taille se déclenche : la boîte n'a pas changé, le zoom non plus.
    const width = frame().style.width;
    for (let i = 0; i < 5; i++) resize(940, 602);
    expect(frame().style.width).toBe(width);
    expect(zoomShown()).toBe("69 %");
  });

  it("le choix « Ajuster à la largeur » revient à la réouverture du rapport et après « Présenter »", async () => {
    const first = open();
    await userEvent.click(screen.getByRole("button", { name: "Ajuster à la largeur" }));
    expect(zoomShown()).toBe("110 %");
    first.unmount(); // « Présenter » ou retour à l'accueil : le canvas est démonté
    open();
    expect(screen.getByRole("button", { name: "Ajuster à la largeur" })).toHaveAttribute("aria-pressed", "true");
    expect(zoomShown()).toBe("110 %");
    expect(localStorage.getItem(ZOOM_STORAGE_KEY)).toBe("width");
  });

  it("un zoom fixe revient pour ce rapport, sans s'imposer à un autre", async () => {
    const first = open();
    await userEvent.click(screen.getByRole("button", { name: "Zoom avant" }));
    expect(zoomShown()).toBe("100 %");
    first.unmount();
    const again = open();
    expect(zoomShown()).toBe("100 %");
    again.unmount();
    open(page, { ...report, id: "r2" });
    expect(zoomShown()).toBe("77 %");
    expect(screen.getByRole("button", { name: /Ajuster$/ })).toHaveAttribute("aria-pressed", "true");
  });

  it("sans barre des pages (canvas seul), le contrôle flotte et la page lui laisse sa place", () => {
    render(<Canvas page={page} report={report} />);
    expect(screen.getByRole("group", { name: "Zoom" })).toBeInTheDocument();
    expect(frame().parentElement!.style.paddingBottom).toBe("56px");
    expect(parseFloat(frame().style.height)).toBeLessThanOrEqual(602 - 48 - 32);
  });

  it("téléphone : le contrôle reste flottant, la barre du bas garde toute sa largeur pour les onglets des pages", () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === NARROW_QUERY, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
    place = { width: 342, height: 600 };
    open();
    const bar = screen.getByRole("navigation", { name: "Pages du rapport" }).parentElement!;
    expect(within(bar).queryByRole("group", { name: "Zoom" })).toBeNull();
    expect(screen.getByRole("group", { name: "Zoom" })).toBeInTheDocument();
    // La largeur borne (23 %) ; la page laisse sa place au contrôle flottant.
    expect(zoomShown()).toBe("23 %");
    expect(frame().parentElement!.style.paddingBottom).toBe("56px");
  });
});
