/// <reference types="node" />
// Lecture directe des fichiers : Vitest neutralise le CSS importé (même en `?raw`).
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");
const indexCss = read("../../index.css");
const colors = read("./colors.css");
const dark = read("./dark.css");
const light = read("./light.css");
const brand = read("../atelier-brand/atelier-brand.css");
const indexHtml = read("../../../index.html");
/** Source de la marque commune (dépôt voisin `atelier_projets`), comparée quand elle est présente. */
const BRAND_REFERENCE = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../atelier_projets/design-system/brand/atelier-brand.css");

/** Variables déclarées dans une feuille (`--nom:`). */
const declared = (css: string) => new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

const FOUNDATION = ["--bg-main", "--bg-surface", "--bg-elevated", "--text-primary", "--text-muted", "--border-color"];
const OFFICIAL = {
  "--type-phase": "#FF8F2B",
  "--type-milestone": "#2A9A30",
  "--type-epic": "#8250DF",
  "--type-story": "#6F42C1",
  "--type-feature": "#2A9A30",
  "--type-task": "#1B66A3",
  "--type-bug": "#D64545",
  "--status-open": "#64748B",
  "--status-progress": "#2563EB",
  "--status-review": "#8B5CF6",
  "--status-hold": "#F59E0B",
  "--status-blocked": "#EA580C",
  "--status-resolved": "#0D9488",
  "--status-closed": "#16A34A",
  "--status-rejected": "#DC2626",
};

describe("design system de la Suite Atelier (copies verbatim, docs/SUITE.md §1.1)", () => {
  it("chaque copie commence par le commentaire d'origine", () => {
    for (const css of [light, dark, colors]) expect(css.trimStart().startsWith("/* ====")).toBe(true);
    expect(light).toContain("Atelier_Projets · Design System — Thème CLAIR");
    expect(dark).toContain("Atelier_Projets · Design System — Thème SOMBRE");
    expect(colors).toContain("Atelier_Projets · Design System — Tokens de couleurs officiels");
  });

  it("les deux thèmes déclarent les 6 variables de fondation", () => {
    for (const css of [light, dark]) {
      const vars = declared(css);
      for (const v of FOUNDATION) expect(vars.has(v), v).toBe(true);
    }
    expect(dark).toContain('[data-theme="dark"]');
  });

  it("les 15 couleurs officielles sont présentes avec leur code", () => {
    expect(Object.keys(OFFICIAL)).toHaveLength(15);
    for (const [name, hex] of Object.entries(OFFICIAL)) expect(colors).toMatch(new RegExp(`${name}:\\s*${hex};`));
  });

  it("index.css importe les copies ; l'habillage dérive des jetons --atelier-* de la marque (§1.2, §1.7)", () => {
    for (const f of ["colors.css", "light.css", "dark.css"]) expect(indexCss).toContain(`./styles/atelier-ds/${f}`);
    const map: [string, string][] = [
      ["--bg", "var(--atelier-bg)"],
      ["--sidebar", "var(--atelier-sidebar)"],
      ["--surface", "var(--atelier-surface)"],
      ["--surface-2", "var(--atelier-surface-2)"],
      ["--surface-3", "var(--atelier-surface-3)"],
      ["--field", "var(--atelier-field)"],
      ["--border", "var(--atelier-border-soft)"],
      ["--border-strong", "var(--atelier-border)"],
      ["--line", "var(--atelier-line)"],
      ["--fg", "var(--atelier-text)"],
      ["--muted", "var(--atelier-muted)"],
      ["--grid", "var(--atelier-line)"],
      ["--accent", "var(--atelier-signature)"],
      ["--accent-fg", "var(--atelier-signature-contrast)"],
      ["--accent-ink", "var(--atelier-ink)"],
      ["--accent-soft", "var(--atelier-signature-soft)"],
    ];
    for (const [token, value] of map) expect(indexCss).toContain(`${token}: ${value};`);
    expect(indexCss).toContain("background: var(--atelier-backdrop), var(--bg);");
    expect(indexCss).not.toMatch(/background-image:\s*var\(--atelier-backdrop\)/);
    expect(indexCss).toMatch(/--positive: color-mix\(in oklab, var\(--status-closed\)/);
    expect(indexCss).toMatch(/--negative: color-mix\(in oklab, var\(--status-rejected\)/);
    // Exception dataviz : la palette des données reste en hexadécimal validé.
    expect(indexCss).toMatch(/--series-1: #2a78d6;/);
    // Aucune police téléchargée.
    expect(indexCss).not.toMatch(/@font-face|fonts\.googleapis|Inter Variable/);
  });

  it("charte néon monochrome : Atelier Viz est tout en jaune, sans bleu nuit ni cyan (§1.7)", () => {
    expect(indexHtml).toMatch(/<html[^>]*data-atelier-app="viz"/);
    expect(brand).toMatch(/--atelier-sig-viz: #f2c811;/i);
    expect(brand).toContain('[data-atelier-app="viz"] { --atelier-signature: var(--atelier-sig-viz);');
    // Jetons de la v1 (base cyan, bleu nuit) : plus aucun usage dans l'habillage.
    expect(indexCss).not.toMatch(/--atelier-(neon|night|glass|edge|signature-light)\b/);
    expect(indexCss).not.toMatch(/#06111f|#0a1b2e|#10283f|#17405c|#3fd8ff/i);
  });

  it("la marque commune définit la signature de chaque app du sélecteur de la suite (§1.7, §3)", () => {
    const signatures = { viz: "#f2c811", tab: "#21a366", projets: "#94d82d", cuisine: "#e056e2" };
    for (const [app, hex] of Object.entries(signatures)) {
      expect(brand).toMatch(new RegExp(`--atelier-sig-${app}: ${hex};`, "i"));
      expect(brand).toContain(`[data-atelier-app="${app}"] { --atelier-signature: var(--atelier-sig-${app});`);
    }
  });

  it.skipIf(!existsSync(BRAND_REFERENCE))("atelier-brand.css est une copie à l'octet près de celle d'Atelier Projets", () => {
    expect(brand).toBe(readFileSync(BRAND_REFERENCE, "utf8"));
  });
});
