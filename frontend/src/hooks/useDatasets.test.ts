import { act, renderHook, waitFor } from "@testing-library/react";

import { ApiError } from "../lib/api";
import { announceExamplesChange } from "../lib/exemples";
import type { DatasetProfile } from "../types/dataset";
import { lostColumns, useDatasets } from "./useDatasets";

const profile: DatasetProfile = {
  id: "abc",
  name: "ventes.csv",
  format: "csv",
  rows: 3,
  columns_count: 2,
  created_at: "2026-10-19T10:00:00Z",
  columns: [
    { name: "date", type: "date", nulls: 0, distinct: 3, min: "2026-01-05", max: "2026-01-07", mean: null, top_values: [] },
    { name: "montant", type: "number", nulls: 0, distinct: 3, min: 1, max: 3, mean: 2, top_values: [] },
  ],
  sample: [],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("lostColumns", () => {
  it("lit les colonnes perdues d'un refus COLUMNS_LOST et ignore les autres erreurs", () => {
    const detail = { code: "COLUMNS_LOST", message: "…", missing: ["montant"], added: ["total"] };
    expect(lostColumns(new ApiError(409, "…", detail))).toEqual({ missing: ["montant"], added: ["total"] });
    expect(lostColumns(new ApiError(409, "…", { ...detail, added: undefined }))).toEqual({ missing: ["montant"], added: [] });
    // Modèle qui ne tient plus, autre statut, détail en texte, liste vide : pas une demande de confirmation.
    expect(lostColumns(new ApiError(409, "…", { message: "…", issues: [] }))).toBeNull();
    expect(lostColumns(new ApiError(422, "…", detail))).toBeNull();
    expect(lostColumns(new ApiError(409, "Ce jeu vient d'une connexion", "Ce jeu vient d'une connexion"))).toBeNull();
    expect(lostColumns(new ApiError(409, "…", { ...detail, missing: [] }))).toBeNull();
    expect(lostColumns(new Error("réseau"))).toBeNull();
  });
});

describe("useDatasets — remplacement des données", () => {
  it("attend la confirmation quand le fichier perd des colonnes, puis renvoie le même fichier avec force", async () => {
    const replaced = { ...profile, rows: 1, columns: [profile.columns[0]!, { ...profile.columns[1]!, name: "total" }] };
    const puts: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PUT") {
        puts.push(url);
        if (url.endsWith("?force=true")) return json(replaced);
        return json({ detail: { code: "COLUMNS_LOST", message: "Le nouveau fichier n'a plus la colonne « montant » : rien n'a changé.", missing: ["montant"], added: ["total"] } }, 409);
      }
      return url.endsWith("/datasets") ? json([profile]) : json(profile);
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useDatasets());
    await waitFor(() => expect(result.current.selected?.id).toBe("abc"));

    const file = new File(["date;total\n03/02/2026;10\n"], "autre.csv", { type: "text/csv" });
    await act(() => result.current.replaceData("abc", file));
    // Refus : rien n'a changé, pas de message d'erreur, la confirmation attend avec le fichier choisi.
    expect(result.current.pendingReplace).toEqual({ id: "abc", file, missing: ["montant"], added: ["total"] });
    expect(result.current.error).toBeNull();
    expect(result.current.replacing).toBeNull();
    expect(result.current.selected?.rows).toBe(3);
    expect(result.current.revision).toBe(0);

    await act(() => result.current.replaceData("abc", file, true));
    expect(puts).toEqual(["/api/datasets/abc/data", "/api/datasets/abc/data?force=true"]);
    expect(result.current.pendingReplace).toBeNull();
    expect(result.current.selected?.columns.map((c) => c.name)).toEqual(["date", "total"]);
    expect(result.current.revision).toBe(1);
  });

  it("abandonne la demande sur « Annuler » et garde un message pour les autres refus", async () => {
    let status = 409;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.method !== "PUT") return String(input).endsWith("/datasets") ? json([profile]) : json(profile);
        if (status === 409) return json({ detail: { code: "COLUMNS_LOST", message: "…", missing: ["montant"], added: [] } }, 409);
        return json({ detail: "Format « .pdf » non pris en charge (CSV, XLSX ou JSON)." }, 422);
      }),
    );
    const { result } = renderHook(() => useDatasets());
    await waitFor(() => expect(result.current.selected?.id).toBe("abc"));
    const file = new File(["x"], "notes.pdf");
    await act(() => result.current.replaceData("abc", file));
    expect(result.current.pendingReplace?.missing).toEqual(["montant"]);
    act(() => result.current.cancelReplace());
    expect(result.current.pendingReplace).toBeNull();

    status = 422;
    await act(() => result.current.replaceData("abc", file));
    expect(result.current.pendingReplace).toBeNull();
    expect(result.current.error).toBe("notes.pdf : Format « .pdf » non pris en charge (CSV, XLSX ou JSON).");
  });
});

describe("useDatasets — exemples de la suite", () => {
  const story = { ...profile, id: "sci1", name: "SCI Les Tilleuls — État locatif" };
  const stub = (lists: DatasetProfile[][]) => {
    let calls = 0;
    const asked: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        asked.push(url);
        if (url.endsWith("/datasets")) return json(lists[Math.min(calls++, lists.length - 1)]);
        const found = [story, profile].find((p) => url.endsWith(`/datasets/${p.id}`));
        return found ? json(found) : json({ detail: "Jeu de données introuvable." }, 404);
      }),
    );
    return asked;
  };

  it("histoire retirée depuis la barre latérale : ses jeux quittent la liste, le jeu affiché cède la place", async () => {
    const asked = stub([[story, profile], [profile]]);
    const { result } = renderHook(() => useDatasets());
    await waitFor(() => expect(result.current.selected?.id).toBe("sci1"));

    act(() => announceExamplesChange());
    await waitFor(() => expect(result.current.datasets.map((d) => d.id)).toEqual(["abc"]));
    // Le jeu supprimé n'est plus affiché ni redemandé (il répondrait 404) : le suivant le remplace.
    await waitFor(() => expect(result.current.selected?.id).toBe("abc"));
    expect(result.current.error).toBeNull();
    expect(asked.filter((u) => u.endsWith("/datasets/sci1"))).toHaveLength(1);
  });

  it("dernière histoire retirée : plus aucun jeu, plus de jeu affiché", async () => {
    stub([[story], []]);
    const { result } = renderHook(() => useDatasets());
    await waitFor(() => expect(result.current.selected?.id).toBe("sci1"));
    act(() => announceExamplesChange());
    await waitFor(() => expect(result.current.datasets).toEqual([]));
    expect(result.current.selected).toBeNull();
  });

  it("histoire chargée : ses jeux s'ajoutent, le jeu affiché ne change pas", async () => {
    const asked = stub([[profile], [story, profile]]);
    const { result } = renderHook(() => useDatasets());
    await waitFor(() => expect(result.current.selected?.id).toBe("abc"));
    act(() => announceExamplesChange());
    await waitFor(() => expect(result.current.datasets.map((d) => d.id)).toEqual(["sci1", "abc"]));
    expect(result.current.selected?.id).toBe("abc");
    expect(asked.some((u) => u.endsWith("/datasets/sci1"))).toBe(false);
  });

  it("premier chargement d'une histoire sur une liste vide : son premier jeu s'affiche", async () => {
    stub([[], [story]]);
    const { result } = renderHook(() => useDatasets());
    await waitFor(() => expect(result.current.loading).toBe(false));
    act(() => announceExamplesChange());
    await waitFor(() => expect(result.current.selected?.id).toBe("sci1"));
  });

  it("ne s'abonne plus une fois démonté", async () => {
    const asked = stub([[profile]]);
    const { result, unmount } = renderHook(() => useDatasets());
    await waitFor(() => expect(result.current.selected?.id).toBe("abc"));
    unmount();
    const before = asked.length;
    announceExamplesChange();
    expect(asked).toHaveLength(before);
  });
});
