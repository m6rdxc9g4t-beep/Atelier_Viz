/// <reference types="node" />
// Lecture directe des fichiers : Vitest neutralise le CSS importé (même en `?raw`).
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(new URL(name, import.meta.url), "utf8");
const indexCss = read("../../index.css");
const colors = read("./colors.css");
const dark = read("./dark.css");
const light = read("./light.css");

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

  it("index.css importe les copies et dérive l'habillage des variables de fondation (§1.2)", () => {
    for (const f of ["colors.css", "light.css", "dark.css"]) expect(indexCss).toContain(`./styles/atelier-ds/${f}`);
    const map: [string, string][] = [
      ["--bg", "var(--bg-main)"],
      ["--surface", "var(--bg-surface)"],
      ["--surface-2", "var(--bg-elevated)"],
      ["--border", "var(--border-color)"],
      ["--fg", "var(--text-primary)"],
      ["--muted", "var(--text-muted)"],
      ["--grid", "var(--border-color)"],
    ];
    for (const [token, value] of map) expect(indexCss).toContain(`${token}: ${value};`);
    expect(indexCss).toMatch(/--accent: color-mix\(in oklab, var\(--type-epic\)/);
    expect(indexCss).toMatch(/--positive: color-mix\(in oklab, var\(--status-closed\)/);
    expect(indexCss).toMatch(/--negative: color-mix\(in oklab, var\(--status-rejected\)/);
    // Exception dataviz : la palette des données reste en hexadécimal validé.
    expect(indexCss).toMatch(/--series-1: #2a78d6;/);
    // Aucune police téléchargée.
    expect(indexCss).not.toMatch(/@font-face|fonts\.googleapis|Inter Variable/);
  });
});
