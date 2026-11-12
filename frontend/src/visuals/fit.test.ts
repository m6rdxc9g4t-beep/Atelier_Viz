import { describe, expect, it } from "vitest";

import {
  CATEGORY_AXIS_MAX,
  RANGE_SIDE_BY_SIDE,
  categoryAxis,
  kpiMinHeight,
  lastTickMargin,
  navigatorTabMinCss,
  navigatorTabMins,
  navigatorTabWidth,
  navigatorWidth,
  rangeSlicerMinHeight,
  textWidth,
  truncateEnd,
  valueLabelMargin,
} from "./fit";

/** Largeurs réelles mesurées dans Chromium (Inter, 11 px), pour étalonner l'estimation. */
const MEASURED_11: Record<string, number> = {
  "2026-043": 53.1,
  "Charges sociales": 89.1,
  "Déplacements": 74.5,
  "sem. 26/10": 57,
  "Clients et factures": 94.4,
  "CARTE BOESNER FOURNITURES ARLES": 208.7,
  "3,5 k €": 35.6,
  "1 234,56 €": 54.6,
  "0123456789": 65.1,
  "Île-de-France": 71,
  "Provence-Alpes-Côte d'Azur": 149,
  "janv. 2026": 54.3,
};

describe("largeur d'un texte", () => {
  it("n'est jamais sous la largeur réelle, ni très au-dessus", () => {
    for (const [text, real] of Object.entries(MEASURED_11)) {
      const estimate = textWidth(text, 11);
      expect(estimate, text).toBeGreaterThanOrEqual(real * 0.99);
      expect(estimate, text).toBeLessThanOrEqual(real * 1.2);
    }
  });

  it("suit la taille du texte et compte les chiffres comme des lettres larges", () => {
    expect(textWidth("2026", 22)).toBeCloseTo(textWidth("2026", 11) * 2);
    // L'ancienne règle (6,2 px par caractère) sous-estimait les libellés en chiffres : « 2026-043 » était rogné.
    expect(textWidth("2026-043", 11)).toBeGreaterThan(8 * 6.2);
    expect(textWidth("illi", 11)).toBeLessThan(textWidth("0000", 11));
  });
});

describe("abréviation par la fin", () => {
  it("laisse le texte qui tient et abrège l'autre avec « … »", () => {
    expect(truncateEnd("Locaux", 100, 11)).toBe("Locaux");
    const cut = truncateEnd("CARTE BOESNER FOURNITURES ARLES", 120, 11);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut.startsWith("CARTE BOESNER")).toBe(true);
    expect(textWidth(cut, 11)).toBeLessThanOrEqual(120);
    // Jamais vide, jamais d'espace avant les points de suspension.
    expect(truncateEnd("Charges sociales", 4, 11)).toBe("C…");
    expect(truncateEnd("Charges sociales", 54, 11)).not.toMatch(/\s…$/);
  });
});

describe("axe des catégories (barres horizontales)", () => {
  it("donne aux numéros de facture la place de leurs chiffres, sans les abréger", () => {
    const axis = categoryAxis(["2026-043", "2026-038", "2026-041"]);
    // 53 px de texte + 8 px de trait et de marge de Recharts.
    expect(axis.width).toBeGreaterThanOrEqual(53.1 + 8);
    expect(axis.format("2026-043")).toBe("2026-043");
  });

  it("garde entier un libellé de plusieurs mots (Recharts le passerait à la ligne dans un axe trop juste)", () => {
    const axis = categoryAxis(["Locaux", "Charges sociales", "Déplacements"]);
    expect(axis.width).toBeGreaterThanOrEqual(89.1 + 8 + 6);
    expect(axis.format("Charges sociales")).toBe("Charges sociales");
  });

  it("borne l'axe et abrège par la fin les libellés trop longs", () => {
    const labels = ["VIR SEPA RECU MAISON VAUCLAIR FACT 2026-036", "Court"];
    const axis = categoryAxis(labels);
    expect(axis.width).toBe(CATEGORY_AXIS_MAX);
    const cut = axis.format(labels[0]!);
    expect(cut.endsWith("…")).toBe(true);
    expect(textWidth(cut, 11)).toBeLessThanOrEqual(CATEGORY_AXIS_MAX - 8);
    expect(axis.format("Court")).toBe("Court");
    expect(categoryAxis([]).width).toBe(48);
  });
});

describe("marges des graphiques", () => {
  it("réserve à droite la moitié de la dernière graduation d'une courbe", () => {
    // « sem. 26/10 » mesure 57 px : centrée sur le dernier point, elle dépasse de 28,5 px.
    expect(lastTickMargin("sem. 26/10")).toBeGreaterThanOrEqual(29);
    expect(lastTickMargin("sem. 26/10")).toBeLessThan(45);
    expect(lastTickMargin("T3")).toBe(12);
    expect(lastTickMargin(undefined)).toBe(12);
  });

  it("réserve la place de la plus longue étiquette de valeur", () => {
    expect(valueLabelMargin(["3,5 k €", "27 €"], 44)).toBe(44);
    expect(valueLabelMargin(["1 234,56 M€"], 44)).toBeGreaterThan(60);
    expect(valueLabelMargin([], 44)).toBe(44);
  });
});

describe("place minimale des visuels", () => {
  it("carte KPI : plus haute avec une mini-tendance", () => {
    expect(kpiMinHeight(true)).toBeGreaterThan(kpiMinHeight(false));
    // L'ancienne rangée de 108 px ne laissait pas la valeur et la courbe l'une sous l'autre.
    expect(kpiMinHeight(true)).toBeGreaterThan(108);
  });

  it("segment de plage : plus haut quand les champs passent l'un sous l'autre", () => {
    const narrow = rangeSlicerMinHeight(200);
    const wide = rangeSlicerMinHeight(RANGE_SIDE_BY_SIDE + 24);
    expect(narrow).toBeGreaterThan(wide);
    expect(narrow).toBeGreaterThan(128);
  });

  it("navigateur : la somme des noms, pas une largeur égale par onglet", () => {
    const names = ["Trésorerie", "Dépenses", "Opérations", "Clients et factures"];
    const w = navigatorWidth(names);
    // Largeurs réelles en gras à 14 px : 68, 65, 74 et 122 px, plus marges et écarts.
    expect(w).toBeGreaterThanOrEqual(68 + 65 + 74 + 122 + 4 * 26 + 3 * 4);
    expect(w).toBeLessThan(572);
    expect(navigatorWidth([...names, "Commandes"])).toBeGreaterThan(w);
  });

  it("navigateur trop étroit : un onglet ne descend ni sous son nom ni sous une part égale", () => {
    const names = ["Trésorerie", "Dépenses", "Opérations", "Plan média", "Performances des régies"];
    // Largeur réelle de « Trésorerie » en gras à 14 px : 68 px ; l'estimation reste juste au-dessus.
    expect(navigatorTabWidth("Trésorerie")).toBeGreaterThanOrEqual(68 + 26);
    expect(navigatorTabWidth("Trésorerie")).toBeLessThan(68 * 1.15 + 26);
    const inner = 558;
    const share = (inner - 4 * 4) / 5;
    const mins = navigatorTabMins(names, inner);
    // Les quatre noms courts gardent leur largeur ; seul le nom long cède, jusqu'à la part égale d'avant.
    expect(mins.slice(0, 4)).toEqual(names.slice(0, 4).map(navigatorTabWidth));
    expect(mins[4]).toBeCloseTo(share);
    expect(navigatorTabWidth(names[4]!)).toBeGreaterThan(share);
    // Assez de place : la borne est la largeur du nom, pour tous.
    expect(navigatorTabMins(names, 2000)).toEqual(names.map(navigatorTabWidth));
    // La même règle en CSS, sans connaître la largeur du navigateur.
    expect(navigatorTabMinCss(names[4]!, 5)).toBe(`min(${navigatorTabWidth(names[4]!)}px, calc((100% - 16px) / 5))`);
    expect(navigatorTabMinCss("Seule", 1)).toBe(`min(${navigatorTabWidth("Seule")}px, calc((100% - 0px) / 1))`);
  });
});
