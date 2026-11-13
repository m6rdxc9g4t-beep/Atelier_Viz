import { beforeEach, describe, expect, it } from "vitest";

import type { Page, Report, Visual } from "../types/report";
import { clampToPage, fitHeight, gridRect, migratePage } from "./grid";
import { moveRect, resizeRect } from "./snap";
import { useStudio } from "./store";
import { FIT_MIN, ZOOM_STORAGE_KEY, fitZoom, forgetZoom, recallZoom, rememberZoom, resolveZoom, stepZoom, wheelZoom, widthZoom } from "./zoom";

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

describe("zoom ajusté à la place disponible", () => {
  /** Place utile du canvas : fenêtre moins barres, volets et marges (24 px de chaque côté). */
  const area = (width: number, height: number) => ({ width: width - 48, height: height - 48 });

  it("écran de 1500 × 730 en lecture : la page entière tient, le bas n'est plus coupé", () => {
    // Avant : ajustée à la largeur seule (110 %), la page faisait 790 px de haut dans 602.
    const a = area(1452, 602);
    const z = fitZoom(PAGE, a);
    expect(z).toBeCloseTo(0.769, 3);
    expect(PAGE.height * z).toBeLessThanOrEqual(a.height);
    expect(PAGE.width * z).toBeLessThanOrEqual(a.width);
    expect(widthZoom(PAGE, a)).toBeGreaterThan(1);
  });

  it("volet ouvert ou replié, fenêtre plus petite : l'ajustement suit la place, la page reste entière", () => {
    // Largeurs du canvas à 1500 px : sans volet, Résumé (320), Demander (384), volets d'édition, Filtres en plus.
    for (const [w, h] of [[1452, 602], [1132, 602], [1068, 602], [940, 602], [748, 602], [1318, 522], [998, 522], [806, 522], [1232, 472], [912, 472], [720, 472], [528, 472]] as const) {
      const a = area(w, h);
      const z = fitZoom(PAGE, a);
      expect(PAGE.width * z, `${w} × ${h}`).toBeLessThanOrEqual(a.width);
      expect(PAGE.height * z, `${w} × ${h}`).toBeLessThanOrEqual(a.height);
      // Jamais plus petit que nécessaire : un des deux côtés touche la place (à l'arrondi du millième près).
      expect(Math.max((PAGE.width * (z + 0.001)) / a.width, (PAGE.height * (z + 0.001)) / a.height), `${w} × ${h}`).toBeGreaterThan(1);
    }
    // Volets d'édition ouverts : c'est la largeur qui borne (70 % comme avant).
    expect(fitZoom(PAGE, area(940, 602))).toBeCloseTo(0.696, 3);
  });

  it("téléphone : la largeur borne, avec un plancher sous lequel on ne descend pas", () => {
    expect(fitZoom(PAGE, area(390, 600))).toBeCloseTo(0.267, 3);
    expect(fitZoom(PAGE, area(200, 600))).toBe(FIT_MIN);
    expect(fitZoom(PAGE, { width: 0, height: 0 })).toBe(1);
  });

  it("page longue : ajustée à la largeur seulement, elle se lit en défilant", () => {
    const tall = { width: 1280, height: 2400 };
    const a = area(1452, 602);
    expect(fitZoom(tall, a)).toBe(widthZoom(tall, a));
    // Une page un peu allongée par un visuel (816 px) reste entière.
    const longer = { width: 1280, height: 816 };
    expect(longer.height * fitZoom(longer, a)).toBeLessThanOrEqual(a.height);
  });

  it("page longue : elle ne rétrécit pas sous les trois quarts de sa taille à la largeur", () => {
    // Écran de 1500 × 730 en édition (volets ouverts) : 892 px de large pour la page, 70 % à la largeur.
    const a = area(940, 602);
    // Avant : une page de 1100 px s'ouvrait à 50 %, une de 1590 px à 35 % (texte de 4,5 px), puis 1620 px sautait à 69 %.
    for (const height of [1100, 1300, 1590, 1620, 2400]) {
      const page = { width: 1280, height };
      expect(fitZoom(page, a), `${height}`).toBe(widthZoom(page, a));
      expect(fitZoom(page, a), `${height}`).toBeGreaterThan(0.69);
    }
    // Un peu allongée (1000 px) : la montrer entière ne lui coûte qu'un cinquième, elle reste entière.
    const longer = { width: 1280, height: 1000 };
    expect(longer.height * fitZoom(longer, a)).toBeLessThanOrEqual(a.height);
    expect(fitZoom(longer, a)).toBeGreaterThan(0.55);
  });

  it("page d'un écran (16:9, 4:3, A4 paysage) : entière même dans une fenêtre large et basse", () => {
    // Portable de 1366 × 768 en lecture : la place est 2,4 fois plus large que haute.
    const a = area(1086, 500);
    for (const page of [PAGE, { width: 960, height: 720 }, { width: 1123, height: 794 }]) {
      const z = fitZoom(page, a);
      expect(page.height * z, `${page.width} × ${page.height}`).toBeLessThanOrEqual(a.height);
      expect(z).toBeLessThan(widthZoom(page, a));
    }
  });

  it("barres de défilement de 15 à 17 px (Chrome sous Windows) : leur apparition ne change jamais le choix", () => {
    // Avant : la place était mesurée sans la barre ; au seuil des pages longues, la barre verticale retirait 15 px,
    // la page repassait « entière », la barre disparaissait, et la page clignotait entre 35 % et 70 % sans fin.
    for (const scrollbar of [15, 16, 17]) {
      for (const [w, h] of [[940, 602], [1132, 602], [1452, 602], [1318, 522], [806, 522]] as const) {
        const a = area(w, h);
        for (let height = 700; height <= 2400; height += 1) {
          const page = { width: 1280, height };
          const z = fitZoom(page, a, scrollbar);
          const label = `${w} × ${h}, page de ${height}, barre de ${scrollbar}`;
          if (page.height * z > a.height) {
            // À la largeur : la barre verticale est là. La page tient dans ce qu'elle laisse (pas de barre
            // horizontale), et remesurer la place sans la barre redonne le même zoom : rien ne bascule.
            const narrowed = { width: a.width - scrollbar, height: a.height };
            expect(page.width * z, label).toBeLessThanOrEqual(narrowed.width);
            expect(fitZoom(page, narrowed), label).toBe(z);
          } else {
            // Entière : aucune barre, donc rien à retirer.
            expect(page.width * z, label).toBeLessThanOrEqual(a.width);
          }
        }
      }
    }
    // « Ajuster à la largeur » réserve la barre de la même façon, et seulement si la page dépasse en hauteur.
    const a = area(940, 602);
    expect(widthZoom({ width: 1280, height: 1605 }, a, 15)).toBeCloseTo((892 - 15) / 1280, 2);
    expect(widthZoom({ width: 1280, height: 400 }, a, 15)).toBeCloseTo(892 / 1280, 2);
    expect(widthZoom({ width: 1280, height: 1605 }, a)).toBeCloseTo(892 / 1280, 2); // barres superposées (macOS, téléphone)
  });

  it("le choix de zoom est retenu : la façon d'ajuster d'une visite à l'autre, un zoom fixe pour le rapport ouvert", () => {
    const kept = new Map<string, string>();
    const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
    forgetZoom();
    expect(recallZoom("r1", storage)).toBe("fit");
    rememberZoom("r1", "width", storage);
    expect(kept.get(ZOOM_STORAGE_KEY)).toBe("width");
    forgetZoom(); // nouvelle visite : la session est vide, le stockage reste
    expect(recallZoom("r1", storage)).toBe("width");
    expect(recallZoom("r2", storage)).toBe("width");
    // Un zoom fixe : pour ce rapport et cette session seulement, jamais écrit.
    rememberZoom("r1", 1.5, storage);
    expect(recallZoom("r1", storage)).toBe(1.5);
    expect(recallZoom("r2", storage)).toBe("width");
    expect(kept.get(ZOOM_STORAGE_KEY)).toBe("width");
    rememberZoom("r1", "fit", storage);
    expect(recallZoom("r2", storage)).toBe("fit");
    // Stockage indisponible ou valeur inconnue : « Ajuster ».
    forgetZoom();
    const broken = { getItem: () => { throw new Error("refusé"); }, setItem: () => { throw new Error("refusé"); } };
    expect(recallZoom("r3", broken)).toBe("fit");
    expect(() => rememberZoom("r3", "width", broken)).not.toThrow();
    expect(recallZoom("r3", broken)).toBe("width"); // gardé pour la session
    forgetZoom();
    expect(recallZoom("r4", { getItem: () => "150" })).toBe("fit");
  });

  it("un zoom choisi à la main ne suit plus la place ; « Ajuster » y revient", () => {
    expect(resolveZoom(0.75, PAGE, area(1452, 602))).toBe(0.75);
    expect(resolveZoom(0.75, PAGE, area(940, 602))).toBe(0.75);
    expect(resolveZoom("fit", PAGE, area(940, 602))).toBe(fitZoom(PAGE, area(940, 602)));
    expect(resolveZoom("width", PAGE, area(1452, 602))).toBe(widthZoom(PAGE, area(1452, 602)));
  });

  it("paliers et molette", () => {
    expect(stepZoom(0.769, 1)).toBe(1);
    expect(stepZoom(0.769, -1)).toBe(0.75);
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(2, 1)).toBeNull();
    expect(stepZoom(0.2, -1)).toBeNull();
    expect(wheelZoom(1, -100)).toBe(1.1);
    expect(wheelZoom(1, 100)).toBe(0.91);
    expect(wheelZoom(2, -100)).toBe(2);
    expect(wheelZoom(0.25, 100)).toBe(0.25);
  });
});
