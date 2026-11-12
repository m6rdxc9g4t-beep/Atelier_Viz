import { describe, expect, it } from "vitest";

import type { Layout } from "../types/report";
import { HANDLE_HEIGHT, HANDLE_LAYER, TOOLBAR_HEIGHT, TOOLBAR_INSET, TOOLBAR_LAYER, TOOLBAR_WIDTH, toolbarSide, toolbarZone } from "./toolbar";

const PAGE = { width: 1280, height: 720 };

describe("barre d'actions d'un visuel", () => {
  it("se pose au-dessus du cadre quand la page a la place", () => {
    expect(toolbarSide({ x: 248, y: 60, w: 247, h: 116 }, PAGE)).toBe("above");
    expect(toolbarSide({ x: 0, y: TOOLBAR_HEIGHT, w: 100, h: 100 }, PAGE)).toBe("above");
  });

  it("passe dessous pour un visuel collé en haut de la page", () => {
    expect(toolbarSide({ x: 700, y: 8, w: 572, h: 44 }, PAGE)).toBe("below");
    expect(toolbarSide({ x: 0, y: 0, w: 100, h: 720 - TOOLBAR_HEIGHT }, PAGE)).toBe("below");
  });

  it("reste dans le cadre seulement quand le visuel occupe toute la hauteur", () => {
    expect(toolbarSide({ x: 8, y: 8, w: 216, h: 704 }, PAGE)).toBe("inside");
    expect(toolbarSide({ x: 0, y: 0, w: 1280, h: 720 }, PAGE)).toBe("inside");
  });

  it("barre dessous + voisin plus bas : elle passe devant la poignée de déplacement du voisin", () => {
    // Rapport généré : navigateur et titre à y = 8, rangée des KPI à y = 60 juste dessous.
    const navigator: Layout = { x: 754, y: 8, w: 518, h: 44 };
    const kpi: Layout = { x: 1025, y: 60, w: 247, h: 116 };
    const side = toolbarSide(navigator, PAGE);
    expect(side).toBe("below");
    const bar = toolbarZone(navigator, side);
    const handle: Layout = { x: kpi.x, y: kpi.y, w: kpi.w, h: HANDLE_HEIGHT };
    // La barre recouvre bien la bande du haut du KPI (sa poignée, invisible tant qu'il n'est pas survolé)…
    const covers = bar.x < handle.x + handle.w && handle.x < bar.x + bar.w && bar.y < handle.y + handle.h && handle.y < bar.y + bar.h;
    expect(covers).toBe(true);
    // … donc son plan d'empilement est strictement au-dessus : ses boutons et sa poignée reçoivent le clic.
    const level = (cls: string) => Number(/^z-(\d+)$/.exec(cls)?.[1]);
    expect(level(TOOLBAR_LAYER)).toBeGreaterThan(level(HANDLE_LAYER));
  });

  it("zone couverte : alignée à droite du visuel, au-dessus, dessous ou dans le cadre", () => {
    const layout: Layout = { x: 100, y: 200, w: 300, h: 150 };
    const x = 100 + 300 - TOOLBAR_INSET - TOOLBAR_WIDTH;
    expect(toolbarZone(layout, "above")).toEqual({ x, y: 200 - TOOLBAR_HEIGHT, w: TOOLBAR_WIDTH, h: TOOLBAR_HEIGHT });
    expect(toolbarZone(layout, "below")).toEqual({ x, y: 350, w: TOOLBAR_WIDTH, h: TOOLBAR_HEIGHT });
    expect(toolbarZone(layout, "inside").y).toBe(200);
    // Six boutons de 20 px, leurs écarts, la poignée d'un bouton ou d'un navigateur et le cadre de la barre.
    expect(TOOLBAR_WIDTH).toBeGreaterThanOrEqual(6 * 20 + 5 * 2 + 6);
  });

  describe("visuels cliquables de la page (navigateur, boutons)", () => {
    // Rapport généré : navigateur en haut à droite, rangée de quatre KPI juste dessous.
    const navigator: Layout = { x: 754, y: 8, w: 518, h: 44 };
    const kpis: Layout[] = [232, 495, 758, 1021].map((x) => ({ x, y: 60, w: 251, h: 116 }));

    it("la barre d'un KPI sous le navigateur passe dessous : aucun onglet n'est recouvert", () => {
      // Sans connaître le navigateur, elle se posait au-dessus, sur l'onglet « Dépenses ».
      expect(kpis.map((k) => toolbarSide(k, PAGE))).toEqual(["above", "above", "above", "above"]);
      // Les deux KPI de droite sont sous le navigateur ; ceux de gauche (sous le titre) gardent le dessus.
      expect(kpis.map((k) => toolbarSide(k, PAGE, [navigator]))).toEqual(["above", "above", "below", "below"]);
      for (const k of kpis) {
        const zone = toolbarZone(k, toolbarSide(k, PAGE, [navigator]));
        const hit = zone.x < navigator.x + navigator.w && navigator.x < zone.x + zone.w && zone.y < navigator.y + navigator.h && navigator.y < zone.y + zone.h;
        expect(hit).toBe(false);
      }
    });

    it("un visuel large dont seule la gauche passe sous un bouton garde sa barre au-dessus (elle est à droite)", () => {
      const button: Layout = { x: 240, y: 180, w: 120, h: 36 };
      expect(toolbarSide({ x: 232, y: 220, w: 1040, h: 300 }, PAGE, [button])).toBe("above");
    });

    it("les deux côtés recouvrent un visuel cliquable, ou l'autre côté sort de la page : elle garde le premier", () => {
      const k = kpis[3]!;
      const under: Layout = { x: 1021, y: 180, w: 251, h: 40 };
      expect(toolbarSide(k, PAGE, [navigator, under])).toBe("above");
      // Visuel collé en bas de la page : dessous impossible, la barre reste au-dessus même sur un bouton.
      const low: Layout = { x: 1021, y: 500, w: 251, h: 220 };
      expect(toolbarSide(low, PAGE, [{ x: 1021, y: 460, w: 251, h: 36 }])).toBe("above");
      // Aucun côté hors du cadre : dans le cadre, comme avant.
      expect(toolbarSide({ x: 0, y: 0, w: 1280, h: 720 }, PAGE, [navigator])).toBe("inside");
    });
  });
});
