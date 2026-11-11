import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Fichier du dépôt visé par un import relatif (`./x`, `../y`), ou `null` pour un paquet npm. */
function target(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts"), resolve(base, "index.tsx")]) {
    if (existsSync(candidate) && /\.(ts|tsx|css|json)$/.test(candidate)) return candidate;
  }
  return null;
}

/**
 * Imports statiques d'un module : ceux qui finissent dans le même paquet que lui. Les `import type` (effacés à la
 * compilation) et les `import()` (chargés à la demande) n'en font pas partie.
 */
function staticImports(file: string): { files: string[]; packages: string[] } {
  const code = readFileSync(file, "utf8");
  const files: string[] = [];
  const packages: string[] = [];
  const pattern = /^\s*(?:import|export)\s+(?!type\b)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gm;
  for (const match of code.matchAll(pattern)) {
    const spec = match[1];
    if (!spec) continue;
    const hit = target(file, spec);
    if (hit) files.push(hit);
    else if (!spec.startsWith(".")) packages.push(spec);
  }
  return { files, packages };
}

/** Tout ce que le navigateur charge avant le premier affichage, à partir de `main.tsx`. */
function initialBundle(): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [resolve(SRC, "main.tsx")];
  while (queue.length) {
    const file = queue.pop();
    if (!file || files.has(file) || !/\.(ts|tsx)$/.test(file)) continue;
    files.add(file);
    const found = staticImports(file);
    found.packages.forEach((p) => packages.add(p));
    queue.push(...found.files);
  }
  return { files, packages };
}

describe("paquet initial", () => {
  const bundle = initialBundle();
  // Chemins relatifs à src/, toujours avec « / » (sous Windows, `resolve` rend des « \ »).
  const relative = [...bundle.files].map((f) => f.slice(SRC.length + 1).replace(/\\/g, "/"));

  it("part bien de l'application", () => {
    expect(relative).toContain("App.tsx");
    expect(relative).toContain("features/reports/ReportsHome.tsx");
  });

  it("ne contient ni le Studio ni le registre des visuels (chargés à l'ouverture d'un rapport)", () => {
    expect(relative).not.toContain("studio/StudioPage.tsx");
    expect(relative).not.toContain("studio/store.ts");
    expect(relative).not.toContain("visuals/registry.ts");
    expect(relative.filter((f) => /^visuals\/(charts|data|maps\/MapVisuals|interactive)/.test(f) && f.endsWith(".tsx"))).toEqual([]);
  });

  it("ne contient pas les bibliothèques de graphiques ni d'export", () => {
    for (const heavy of ["recharts", "d3-geo", "pptxgenjs", "pdf-lib", "jszip", "html-to-image"]) {
      expect(bundle.packages, heavy).not.toContain(heavy);
    }
  });
});
