import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { blend, contrast } from "../../theme/color";
import { SCALES } from "../../theme/scales";
import type { Visual } from "../../types/report";
import { parseNumber } from "../../studio/panes/ConditionalSection";
import { EMPTY_FORMAT, MAX_TINT, MIN_TINT, RULE_TINT, decorHex, decorStyle, decorate, formatFor, isFormatted, ruleMatches, statsOf } from "./conditional";

const v = (options: Visual["options"]): Visual => ({ id: "t", type: "table", title: null, layout: { x: 0, y: 0, w: 1, h: 1 }, roles: {}, options, filters: [] });
const stats = statsOf([-50, 0, 10, 20, 30, 40, 100])!;

describe("mise en forme conditionnelle", () => {
  it("lit la configuration par mesure, avec l'ancienne option « Barres de données »", () => {
    expect(formatFor(v({}), "sum(ca)")).toEqual(EMPTY_FORMAT);
    expect(formatFor(v({ dataBars: true }), "sum(ca)").bars).toBe(true);
    const f = formatFor(v({ dataBars: true, conditional: { "sum(ca)": { bars: false, scale: "sequential" } } }), "sum(ca)");
    expect(f).toMatchObject({ bars: false, scale: "sequential", rules: [] });
    expect(isFormatted(f)).toBe(true);
    expect(isFormatted(EMPTY_FORMAT)).toBe(false);
  });

  it("calcule min, max, tiers et maximum absolu sans les valeurs manquantes", () => {
    expect(statsOf([null, undefined, Number.NaN])).toBeNull();
    expect(statsOf([3, null, 1, 2])).toEqual({ min: 1, max: 3, low: 2, high: 2, absMax: 3 });
    expect(stats).toMatchObject({ min: -50, max: 100, absMax: 100 });
  });

  it("dégradé séquentiel et divergent centré sur zéro", () => {
    const seq = { ...EMPTY_FORMAT, scale: "sequential" as const };
    expect(decorate(-50, seq, stats).fill).toEqual({ tone: "seq", tint: MIN_TINT });
    expect(decorate(100, seq, stats).fill).toEqual({ tone: "seq", tint: MAX_TINT });
    const div = { ...EMPTY_FORMAT, scale: "diverging" as const };
    expect(decorate(100, div, stats).fill).toEqual({ tone: "div-pos", tint: MAX_TINT });
    expect(decorate(-50, div, stats).fill?.tone).toBe("div-neg");
    expect(decorate(0, div, stats).fill?.tint).toBe(0); // le centre reste neutre
    expect(decorate(null, div, stats)).toEqual({});
  });

  it("règles : la première vérifiée l'emporte, sur le fond ou le texte", () => {
    expect(ruleMatches({ op: "between", value: 50, value2: 10, color: "accent" }, 20)).toBe(true);
    const f = {
      ...EMPTY_FORMAT,
      scale: "sequential" as const,
      rules: [
        { op: "gte" as const, value: 100, color: "positive" as const },
        { op: "lt" as const, value: 0, color: "negative" as const },
      ],
    };
    expect(decorate(100, f, stats).fill).toEqual({ tone: "positive", tint: RULE_TINT });
    expect(decorate(-5, f, stats).fill?.tone).toBe("negative");
    expect(decorate(20, f, stats).fill?.tone).toBe("seq");
    expect(decorate(-5, { ...f, rulesTarget: "text" }, stats)).toMatchObject({ text: "negative", fill: { tone: "seq" } });
  });

  it("barres et icônes (signe, tiers)", () => {
    expect(decorate(-50, { ...EMPTY_FORMAT, bars: true }, stats).bar).toEqual({ ratio: 0.5, negative: true });
    const sign = { ...EMPTY_FORMAT, icons: "sign" as const };
    expect([5, -5, 0].map((x) => decorate(x, sign, stats).icon?.glyph)).toEqual(["up", "down", "flat"]);
    const thirds = { ...EMPTY_FORMAT, icons: "terciles" as const };
    expect([100, 20, -50].map((x) => decorate(x, thirds, stats).icon?.glyph)).toEqual(["up", "flat", "down"]);
  });

  it("styles d'écran en variables de thème, couleurs d'export en hexadécimal", () => {
    const d = decorate(100, { ...EMPTY_FORMAT, scale: "sequential", rules: [{ op: "gt", value: 50, color: "negative" }], rulesTarget: "text" }, stats);
    expect(decorStyle(d)).toEqual({ backgroundColor: "color-mix(in oklab, var(--seq-500) 55%, transparent)", color: "var(--cond-neg)" });
    expect(decorHex(d, SCALES.light, "#ffffff")).toEqual({ fill: blend("#256abf", "#ffffff", MAX_TINT), text: "#d03b3b", icon: undefined });
  });

  it("le texte reste lisible (≥ 4,5:1) sur les fonds les plus teintés, en clair et en sombre", () => {
    const modes = { light: { surface: "#fcfcfb", fg: "#0b0b0b" }, dark: { surface: "#1a1a19", fg: "#f0efec" } } as const;
    for (const mode of ["light", "dark"] as const) {
      const c = SCALES[mode];
      for (const tone of [c.seq, c.divPos, c.divNeg, c.positive, c.negative, c.accent]) {
        const bg = blend(tone, modes[mode].surface, MAX_TINT);
        expect(contrast(modes[mode].fg, bg), `${mode} ${tone}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("les couleurs d'export sont celles de index.css", () => {
    const css = readFileSync(resolve(__dirname, "../../index.css"), "utf8");
    // Blocs de la palette de données (ceux qui définissent --seq-500), clair puis sombre.
    const blocks = [...css.matchAll(/\n([^{}\n][^{}]*)\{([^}]*--seq-500[^}]*)\}/g)];
    const of = (selector: string) => blocks.find((m) => (m[1] ?? "").includes(selector))?.[2] ?? "";
    const value = (b: string, name: string) => new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i").exec(b)?.[1]?.toLowerCase();
    for (const [mode, sel] of [["light", ".theme-light"], ["dark", ".theme-dark"]] as const) {
      const b = of(sel);
      const c = SCALES[mode];
      expect([value(b, "seq-500"), value(b, "div-pos"), value(b, "div-neg"), value(b, "cond-pos"), value(b, "cond-neg"), value(b, "cond-blue"), value(b, "cond-grey")]).toEqual([
        c.seq, c.divPos, c.divNeg, c.positive, c.negative, c.accent, c.muted,
      ]);
    }
  });

  it("saisie des seuils à la française", () => {
    expect(parseNumber("1 000,5")).toBe(1000.5);
    expect(parseNumber("-3")).toBe(-3);
    expect(parseNumber("abc")).toBeNull();
    expect(parseNumber("")).toBeNull();
  });
});
