import { describe, expect, it } from "vitest";

import { configError, pendingCount, resultLines } from "./github";

describe("synchronisation GitHub", () => {
  it("valide la configuration", () => {
    expect(configError({ repo: "equipe/rapports", branch: "main", folder: "atelier-viz/rapports" })).toBeNull();
    expect(configError({ repo: "rapports", branch: "main", folder: "" })).toMatch(/propriétaire\/dépôt/);
    expect(configError({ repo: "a/b", branch: "a..b", folder: "" })).toMatch(/branche/);
    expect(configError({ repo: "a/b", branch: "main", folder: "../secret" })).toMatch(/Dossier/);
    expect(configError({ repo: "a/b", branch: "main", folder: "x/.git/hooks" })).toMatch(/Dossier/);
  });

  it("compte les rapports à envoyer et résume les résultats", () => {
    const at = "2026-10-19T08:00:00Z";
    expect(
      pendingCount([
        { id: "a", name: "A", updated_at: at, state: "new" },
        { id: "b", name: "B", updated_at: at, state: "synced" },
        { id: "c", name: "C", updated_at: at, state: "modified" },
      ]),
    ).toBe(2);
    expect(
      resultLines({ commit_sha: "x", commit_url: null, pushed: ["Ventes"], unchanged: 1, remote_newer: ["Stocks"], conflicts: [], message: "" }),
    ).toEqual(["Envoyés : Ventes", "Plus récents sur GitHub (à récupérer) : Stocks"]);
    expect(
      resultLines({ imported: ["A"], updated: [], copies: ["B (copie GitHub)"], kept_local: [], unchanged: 0, conflicts: [], skipped: [{ path: "x.json", reason: "illisible" }], message: "" }),
    ).toEqual(["Importés : A", "Copies importées : B (copie GitHub)", "Ignoré : x.json — illisible"]);
  });
});
