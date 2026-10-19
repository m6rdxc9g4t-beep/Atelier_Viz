import { beforeEach, describe, expect, it } from "vitest";

import type { Page, Report, Visual } from "../types/report";
import { clampToPage, fitHeight, gridRect, migratePage } from "./grid";
import { moveRect, resizeRect } from "./snap";
import { useStudio } from "./store";

const PAGE = { width: 1280, height: 720 };

const vis = (id: string, layout: Visual["layout"]): Visual => ({ id, type: "kpi", title: null, layout, roles: {}, options: {}, filters: [] });

describe("migration des anciens rapports (grille de 24 colonnes)", () => {
  it("convertit les cases en pixels avec les mêmes positions qu'avant", () => {
    const legacy: Page = { id: "p", name: "P", filters: [], visuals: [vis("a", { x: 0, y: 0, w: 24, h: 8 }), vis("b", { x: 12, y: 8, w: 12, h: 40 })] };
    const page = migratePage(legacy);
    expect(page.visuals[0]?.layout).toEqual({ x: 4, y: 4, w: 1272, h: 184 });
    const r = gridRect({ x: 12, y: 8, w: 12, h: 40 });
    expect(page.visuals[1]?.layout).toEqual({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });
    // Page 1280 de large, allongée pour contenir le visuel du bas (196 + 952 = 1148 px).
    expect(page.size?.width).toBe(1280);
    expect(page.size?.height).toBeGreaterThanOrEqual(1148 + 16);
    // Une page déjà en pixels n'est pas touchée.
    expect(migratePage(page)).toBe(page);
  });

  it("borne un visuel dans la largeur de la page", () => {
    expect(clampToPage({ x: 1200, y: -5, w: 300, h: 10 }, PAGE)).toEqual({ x: 980, y: 0, w: 300, h: 30 });
    expect(clampToPage({ x: 0, y: 0, w: 5000, h: 100 }, PAGE)).toMatchObject({ x: 0, w: 1280 });
  });

  it("allonge la page sans jamais la raccourcir", () => {
    const p: Page = { id: "p", name: "P", filters: [], size: PAGE, visuals: [vis("a", { x: 0, y: 900, w: 100, h: 100 })] };
    expect(fitHeight(p)).toBe(1016);
    expect(fitHeight({ ...p, visuals: [] })).toBe(720);
  });
});

describe("déplacement et repères d'alignement", () => {
  const other = { x: 400, y: 100, w: 200, h: 100 };

  it("déplace au pixel près sans accroche (Alt)", () => {
    const r = moveRect({ x: 10, y: 10, w: 100, h: 50 }, 393.4, 87.6, [other], PAGE, 6, false);
    expect(r.rect).toEqual({ x: 403, y: 98, w: 100, h: 50 });
    expect(r.guides).toEqual({ x: [], y: [] });
  });

  it("accroche le bord gauche et le haut sur ceux d'un autre visuel", () => {
    const r = moveRect({ x: 10, y: 10, w: 100, h: 50 }, 393, 87, [other], PAGE, 6, true);
    expect(r.rect).toMatchObject({ x: 400, y: 100 });
    expect(r.guides.x).toContain(400);
    expect(r.guides.y).toContain(100);
  });

  it("accroche le centre sur le centre de la page", () => {
    const r = moveRect({ x: 0, y: 300, w: 200, h: 50 }, 538, 0, [], PAGE, 6, true);
    expect(r.rect.x + r.rect.w / 2).toBe(640);
    expect(r.guides.x).toContain(640);
  });

  it("reste dans la largeur de la page, mais peut descendre sous le bas", () => {
    const r = moveRect({ x: 100, y: 100, w: 200, h: 100 }, 5000, 2000, [], PAGE, 6, false);
    expect(r.rect).toEqual({ x: 1080, y: 2100, w: 200, h: 100 });
  });

  it("redimensionne par un coin, avec taille minimale et proportions (Maj)", () => {
    const orig = { x: 100, y: 100, w: 200, h: 100 };
    expect(resizeRect(orig, "se", 50, 20, [], PAGE, 6, false).rect).toEqual({ x: 100, y: 100, w: 250, h: 120 });
    expect(resizeRect(orig, "nw", 500, 500, [], PAGE, 6, false).rect).toEqual({ x: 260, y: 170, w: 40, h: 30 });
    expect(resizeRect(orig, "se", 100, 0, [], PAGE, 6, false, true).rect).toEqual({ x: 100, y: 100, w: 300, h: 150 });
    // Bord droit accroché au bord gauche d'un autre visuel.
    expect(resizeRect(orig, "e", 97, 0, [other], PAGE, 6, true).rect.w).toBe(300);
  });
});

describe("actions du Studio", () => {
  const report = (): Report => ({
    id: "r",
    name: "R",
    version: 1,
    dataset_id: null,
    theme: {},
    created_at: "",
    updated_at: "",
    pages: [{ id: "p1", name: "P", filters: [], size: { ...PAGE }, visuals: [vis("a", { x: 16, y: 16, w: 200, h: 100 }), vis("b", { x: 300, y: 16, w: 200, h: 100 })] }],
  });

  beforeEach(() => useStudio.getState().load(report()));

  it("convertit un ancien rapport à l'ouverture et le marque à enregistrer", () => {
    const legacy = report();
    delete legacy.pages[0]!.size;
    legacy.pages[0]!.visuals = [vis("a", { x: 0, y: 0, w: 24, h: 8 })];
    useStudio.getState().load(legacy);
    const st = useStudio.getState();
    expect(st.page()?.visuals[0]?.layout).toEqual({ x: 4, y: 4, w: 1272, h: 184 });
    expect(st.saveState).toBe("dirty");
  });

  it("place, ajuste au clavier (une seule annulation), réordonne et agrandit la page", () => {
    const st = useStudio.getState;
    st().setLayout("a", { x: 20, y: 700, w: 200, h: 100 });
    expect(st().page()?.size?.height).toBe(816);
    const before = st().past.length;
    st().nudge("a", 1, 0);
    st().nudge("a", 1, 0);
    st().nudge("a", 0, -10);
    expect(st().page()?.visuals.find((v) => v.id === "a")?.layout).toMatchObject({ x: 22, y: 690 });
    expect(st().past.length).toBe(before + 1);
    // Pas de sortie par la gauche.
    st().nudge("a", -100, 0);
    expect(st().page()?.visuals.find((v) => v.id === "a")?.layout.x).toBe(0);

    st().reorder("a", "front");
    expect(st().page()?.visuals.map((v) => v.id)).toEqual(["b", "a"]);
    st().reorder("a", "back");
    expect(st().page()?.visuals.map((v) => v.id)).toEqual(["a", "b"]);
  });

  it("change la taille de la page en gardant les visuels dedans", () => {
    const st = useStudio.getState;
    st().setPageSize({ width: 400, height: 300 });
    const page = st().page();
    expect(page?.size).toEqual({ width: 400, height: 300 });
    expect(page?.visuals.find((v) => v.id === "b")?.layout).toMatchObject({ x: 200, w: 200 });
  });

  it("décale une copie de 16 px", () => {
    useStudio.getState().duplicateVisual("a");
    expect(useStudio.getState().page()?.visuals.at(-1)?.layout).toEqual({ x: 32, y: 32, w: 200, h: 100 });
  });
});
