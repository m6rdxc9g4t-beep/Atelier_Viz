import { describe, expect, it } from "vitest";

import type { Layout } from "../types/report";
import { HANDLE_HEIGHT, HANDLE_LAYER, TOOLBAR_HEIGHT, TOOLBAR_LAYER, toolbarSide, toolbarZone } from "./toolbar";

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

  it("zone couverte : au-dessus, dessous ou dans le cadre", () => {
    const layout: Layout = { x: 100, y: 200, w: 300, h: 150 };
    expect(toolbarZone(layout, "above")).toEqual({ x: 100, y: 200 - TOOLBAR_HEIGHT, w: 300, h: TOOLBAR_HEIGHT });
    expect(toolbarZone(layout, "below")).toEqual({ x: 100, y: 350, w: 300, h: TOOLBAR_HEIGHT });
    expect(toolbarZone(layout, "inside").y).toBe(200);
  });
});
