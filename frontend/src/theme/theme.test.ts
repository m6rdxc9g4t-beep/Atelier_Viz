import { blend, contrast, isHex, normalizeHex, rgba } from "./color";
import { PRESETS, effectiveOpacity, importTheme, readTheme, themeVars, visualCss } from "./reportTheme";

describe("couleurs hexadécimales", () => {
  it("valide, normalise et mélange", () => {
    expect(isHex("#28d")).toBe(true);
    expect(isHex("#2a78d6")).toBe(true);
    expect(isHex("2a78d6")).toBe(false);
    expect(isHex("#2a78dz")).toBe(false);
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(blend("#ffffff", "#000000", 0.5)).toBe("#808080");
    expect(rgba("#ff0000", 0.25)).toBe("rgba(255, 0, 0, 0.25)");
  });

  it("calcule le contraste WCAG", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 0);
    expect(contrast("#777777", "#777777")).toBeCloseTo(1, 5);
  });
});

describe("thèmes de rapport", () => {
  it("« Appli » (vide) suit l'application", () => {
    expect(readTheme({})).toBeNull();
    expect(readTheme({ mode: "auto" })).toBeNull();
  });

  it("chaque préréglage produit des variables complètes, palettes de 8 couleurs", () => {
    for (const p of PRESETS) {
      const vars = themeVars(p.theme);
      expect(vars["--series-8"]).toMatch(/^#/);
      expect(vars["--page-bg"]).toBe(p.theme.page);
      // Texte lisible sur la surface des visuels (4,5:1)
      expect(contrast(p.theme.text, String(vars["--surface"]))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("un fond transparent garde une surface pleine pour les info-bulles", () => {
    const glass = PRESETS.find((p) => p.id === "glass")!.theme;
    const vars = themeVars(glass);
    expect(vars["--visual-bg"]).toBe("rgba(255, 255, 255, 0)");
    expect(vars["--surface"]).toBe(glass.page);
  });

  it("répare un thème partiel et ignore les valeurs invalides", () => {
    const t = readTheme({ mode: "dark", page: "#123", text: "rouge", palette: ["#ff0000", "nope"], visual: { radius: 99 } })!;
    expect(t.page).toBe("#112233");
    expect(t.text).toBe("#f0efec");
    expect(t.palette[0]).toBe("#ff0000");
    expect(t.palette).toHaveLength(8);
    expect(t.visual.radius).toBe(32);
  });

  it("importe un thème Power BI", () => {
    const t = importTheme({ name: "Corp", dataColors: ["#118DFF", "#12239E"], background: "#FFFFFF", foreground: "#252423", tableAccent: "#118DFF" });
    expect(t.mode).toBe("light");
    expect(t.palette.slice(0, 2)).toEqual(["#118dff", "#12239e"]);
    expect(t.text).toBe("#252423");
    expect(() => importTheme({ foo: 1 })).toThrow(/Format non reconnu/);
  });
});

describe("style d'un visuel", () => {
  it("fond hex, transparence, bordure, palette propre", () => {
    const css = visualCss({ background: "#1e293b", borderColor: "#f59e0b", borderWidth: 2, radius: 16, palette: ["#7c3aed"] }, "#f4f4f2");
    expect(css.background).toBe("rgba(30, 41, 59, 1)");
    expect(css.border).toBe("2px solid #f59e0b");
    expect(css.borderRadius).toBe("16px");
    expect(css["--series-1"]).toBe("#7c3aed");
    // Fond sombre dans un rapport clair : encre claire et quadrillage adaptés
    expect(css["--fg"]).toBe("#f0efec");
    expect(css["--grid"]).not.toBe(undefined);
  });

  it("opacité 0 = transparent ; choisir une couleur implique un fond opaque", () => {
    expect(visualCss({ background: "#ffffff", backgroundOpacity: 0 }, "#eef2f6").background).toBe("rgba(255, 255, 255, 0)");
    expect(effectiveOpacity({ background: "#ffffff" }, 0)).toBe(100);
    expect(effectiveOpacity({}, 0)).toBe(0);
    expect(visualCss({ border: false }, null).border).toBe("1px solid transparent");
  });
});
