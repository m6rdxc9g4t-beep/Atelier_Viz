import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { useDatasets, type DatasetsState } from "../../hooks/useDatasets";
import { announceExamplesChange } from "../../lib/exemples";
import { formatValue } from "../../lib/format";
import type { DatasetProfile, WorkbookSheet } from "../../types/dataset";
import { DataView } from "./DataView";

const profile: DatasetProfile = {
  id: "abc",
  name: "ventes.csv",
  format: "csv",
  rows: 2,
  columns_count: 2,
  created_at: "2026-10-19T10:00:00Z",
  columns: [
    { name: "date", type: "date", nulls: 0, distinct: 2, min: "2026-01-05", max: "2026-01-06", mean: null, top_values: [] },
    { name: "montant", type: "number", nulls: 1, distinct: 1, min: 800, max: 800, mean: 800, top_values: [] },
  ],
  sample: [],
};

function state(overrides: Partial<DatasetsState> = {}): DatasetsState {
  return {
    datasets: [profile],
    selected: profile,
    loading: false,
    uploading: false,
    error: null,
    select: vi.fn(),
    upload: vi.fn(),
    pendingWorkbook: null,
    importSheets: vi.fn(),
    cancelWorkbook: vi.fn(),
    notice: null,
    clearNotice: vi.fn(),
    loadSamples: vi.fn(),
    remove: vi.fn(),
    added: vi.fn(),
    refresh: vi.fn(),
    refreshing: null,
    replaceData: vi.fn(),
    replacing: null,
    pendingReplace: null,
    cancelReplace: vi.fn(),
    revision: 0,
    clearError: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          columns: ["date", "montant"],
          rows: [
            { date: "2026-01-05", montant: 1200.5 },
            { date: "2026-01-06", montant: null },
          ],
          total: 2,
          offset: 0,
          limit: 100,
        }),
      ),
    ),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("DataView", () => {
  it("propose de charger les données d'exemple quand rien n'est importé", async () => {
    const loadSamples = vi.fn();
    render(<DataView state={state({ datasets: [], selected: null, loadSamples })} />);
    await userEvent.click(screen.getByRole("button", { name: "Charger les données d'exemple" }));
    expect(loadSamples).toHaveBeenCalledOnce();
  });

  it("affiche une zone de dépôt quand aucun jeu n'est importé", () => {
    render(<DataView state={state({ datasets: [], selected: null })} />);
    expect(screen.getByText("Déposez un fichier de données")).toBeInTheDocument();
  });

  it("liste les champs et déplie leurs statistiques", async () => {
    render(<DataView state={state()} />);
    const fields = screen.getByRole("region", { name: "Champs" });
    await userEvent.click(within(fields).getByRole("button", { name: /montant/ }));
    expect(within(fields).getByText("Moyenne")).toBeInTheDocument();
    expect(within(fields).getByText("1 ∅")).toBeInTheDocument();
  });

  it("affiche l'aperçu formaté à la française", async () => {
    render(<DataView state={state()} />);
    const preview = screen.getByRole("region", { name: "Aperçu" });
    // Intl insère une espace fine insécable comme séparateur de milliers : on compare sans espaces.
    const expected = formatValue(1200.5, "number").replace(/\s/g, "");
    expect(await within(preview).findByText((text) => text.replace(/\s/g, "") === expected)).toBeInTheDocument();
    expect(within(preview).getByText("05/01/2026")).toBeInTheDocument();
    expect(within(preview).getByText("—")).toBeInTheDocument();
  });

  it("indique la source d'un jeu importé depuis une connexion et l'actualise", async () => {
    const refresh = vi.fn();
    const origin = {
      connection_id: "c1",
      connection_name: "Entrepôt",
      kind: "postgres" as const,
      table: { schema: "public", name: "ventes" },
      query: null,
      url: null,
      project_id: null,
      max_rows: null,
      truncated: false,
      refreshed_at: new Date().toISOString(),
    };
    const fromDb = { ...profile, origin };
    render(<DataView state={state({ datasets: [fromDb], selected: fromDb, refresh })} />);
    expect(screen.getByText(/PostgreSQL · Entrepôt · actualisé à l'instant/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Actualiser" }));
    expect(refresh).toHaveBeenCalledWith("abc");
  });

  it("n'offre pas d'actualisation pour un fichier importé, mais propose de se connecter", () => {
    render(<DataView state={state()} />);
    expect(screen.queryByRole("button", { name: "Actualiser" })).toBeNull();
    expect(screen.getByRole("button", { name: "Se connecter à une source" })).toBeInTheDocument();
  });

  it("remplace les données d'un fichier importé par un nouvel export, sans créer un second jeu", async () => {
    const replaceData = vi.fn();
    const upload = vi.fn();
    render(<DataView state={state({ replaceData, upload })} />);
    expect(screen.getByRole("button", { name: "Remplacer les données…" })).toBeEnabled();
    const file = new File(["date;montant\n03/02/2026;10\n"], "ventes_fevrier.csv", { type: "text/csv" });
    await userEvent.upload(screen.getByLabelText("Choisir le fichier qui remplace les données de ventes.csv"), file);
    expect(replaceData).toHaveBeenCalledWith("abc", file);
    expect(upload).not.toHaveBeenCalled();
  });

  it("demande confirmation, colonnes perdues à l'appui, avant de remplacer par un fichier qui n'a plus toutes les colonnes", async () => {
    const replaceData = vi.fn();
    const cancelReplace = vi.fn();
    const file = new File(["date;total;note\n03/02/2026;10;ok\n"], "autre.csv", { type: "text/csv" });
    const pendingReplace = { id: "abc", file, missing: ["montant"], added: ["total", "note"] };
    const { rerender } = render(<DataView state={state({ replaceData, cancelReplace, pendingReplace })} />);
    const dialog = screen.getByRole("alertdialog", { name: "Confirmer le remplacement des données" });
    expect(dialog).toHaveTextContent("« autre.csv » n'a plus la colonne « montant ».");
    expect(dialog).toHaveTextContent("Rien n'a changé pour l'instant.");
    expect(dialog).toHaveTextContent("Nouvelles colonnes du fichier : « total », « note ».");
    // « Annuler » a le focus : Entrée ne remplace jamais par mégarde.
    expect(within(dialog).getByRole("button", { name: "Annuler" })).toHaveFocus();
    expect(replaceData).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Remplacer quand même" }));
    expect(replaceData).toHaveBeenCalledWith("abc", file, true);
    await userEvent.click(within(dialog).getByRole("button", { name: "Annuler" }));
    expect(cancelReplace).toHaveBeenCalledOnce();
    // Plusieurs colonnes perdues : accord du message ; la demande d'un autre jeu n'est pas affichée ici.
    rerender(<DataView state={state({ pendingReplace: { ...pendingReplace, missing: ["date", "montant"], added: [] } })} />);
    expect(screen.getByRole("alertdialog")).toHaveTextContent("n'a plus les colonnes « date », « montant ».");
    rerender(<DataView state={state({ pendingReplace: { ...pendingReplace, id: "autre" } })} />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("ne propose le remplacement par fichier ni pour une connexion ni pour un workflow, et le bloque pendant l'envoi", () => {
    const workflow = { ...profile, origin: { kind: "atelier-table" as const, key: "nexus:hebdo", table_name: "t", refreshed_at: new Date().toISOString() } };
    const { unmount } = render(<DataView state={state({ datasets: [workflow], selected: workflow })} />);
    expect(screen.queryByRole("button", { name: "Remplacer les données…" })).toBeNull();
    unmount();
    render(<DataView state={state({ replacing: "abc" })} />);
    expect(screen.getByRole("button", { name: "Remplacement…" })).toBeDisabled();
  });

  it("affiche les erreurs d'import", () => {
    render(<DataView state={state({ error: "notes.pdf : Format non pris en charge" })} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Format non pris en charge");
  });
});

describe("DataView — exemples de la suite", () => {
  /** L'écran branché sur le vrai état des jeux, comme dans `App`. */
  function Screen() {
    return <DataView state={useDatasets()} />;
  }

  it("histoire retirée depuis le dialogue de la barre latérale : ses jeux disparaissent de la liste et de l'aperçu", async () => {
    const story = { ...profile, id: "sci1", name: "SCI Les Tilleuls — État locatif" };
    let removed = false;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/datasets")) return json(removed ? [profile] : [story, profile]);
        if (url.includes("/datasets/sci1")) return removed ? json({ detail: "Jeu de données « sci1 » introuvable." }, 404) : url.endsWith("/sci1") ? json(story) : json({ columns: [], rows: [], total: 0, offset: 0, limit: 100 });
        return url.endsWith("/abc") ? json(profile) : json({ columns: [], rows: [], total: 0, offset: 0, limit: 100 });
      }),
    );
    render(<Screen />);
    const tabs = await screen.findByRole("tablist", { name: "Jeux de données" });
    await waitFor(() => expect(within(tabs).getByRole("tab", { name: /SCI Les Tilleuls/ })).toHaveAttribute("aria-selected", "true"));
    expect(await screen.findByRole("heading", { name: "SCI Les Tilleuls — État locatif" })).toBeInTheDocument();

    removed = true;
    act(() => announceExamplesChange());
    await waitFor(() => expect(within(tabs).queryByRole("tab", { name: /SCI Les Tilleuls/ })).toBeNull());
    // Le jeu retiré n'est plus affiché : le suivant prend sa place, sans message « introuvable ».
    expect(await screen.findByRole("heading", { name: "ventes.csv" })).toBeInTheDocument();
    expect(within(tabs).getByRole("tab", { name: /ventes\.csv/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText(/introuvable/)).toBeNull();
  });
});

describe("DataView — classeur à plusieurs feuilles", () => {
  const sheet = (name: string, rows: number, columns: string[], error: string | null = null): WorkbookSheet => ({ name, dataset_name: `Budget 2026 — ${name}`, rows, columns, error });
  const sheets = [sheet("Ventes", 3, ["Mois", "Région", "Montant"]), sheet("Notes", 0, [], "Feuille vide : aucune donnée à importer."), sheet("Objectifs été", 2, ["Région", "Objectif"])];
  const file = new File(["x"], "Budget 2026.xlsx");
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const imported = (name: string, id: string): DatasetProfile => ({ ...profile, id, name: `Budget 2026 — ${name}`, format: "xlsx", sheet: name });

  it("liste toutes les feuilles, cochées par défaut ; la feuille vide est signalée sans case à cocher", async () => {
    const importSheets = vi.fn();
    render(<DataView state={state({ pendingWorkbook: { file, sheets, error: null }, importSheets })} />);
    const dialog = screen.getByRole("dialog", { name: "Feuilles à importer" });
    expect(dialog).toHaveTextContent("Budget 2026.xlsx · 3 feuilles, un jeu de données par feuille");
    const boxes = within(dialog).getAllByRole("checkbox");
    expect(boxes).toHaveLength(2);
    for (const box of boxes) expect(box).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: /Ventes/ })).toBeInTheDocument();
    expect(within(dialog).getByText("3 lignes · 3 colonnes — Mois, Région, Montant")).toBeInTheDocument();
    expect(within(dialog).getByText("Jeu « Budget 2026 — Objectifs été »")).toBeInTheDocument();
    expect(within(dialog).getByText("Laissée de côté — Feuille vide : aucune donnée à importer.")).toBeInTheDocument();
    expect(within(dialog).getByText("2 sur 2 feuilles cochées")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Importer 2 feuilles" }));
    expect(importSheets).toHaveBeenCalledWith(["Ventes", "Objectifs été"]);
  });

  it("décocher une feuille l'écarte de l'import ; sans feuille cochée, rien ne part", async () => {
    const importSheets = vi.fn();
    const cancelWorkbook = vi.fn();
    render(<DataView state={state({ pendingWorkbook: { file, sheets, error: null }, importSheets, cancelWorkbook })} />);
    const dialog = screen.getByRole("dialog", { name: "Feuilles à importer" });
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /Ventes/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Importer 1 feuille" }));
    expect(importSheets).toHaveBeenCalledWith(["Objectifs été"]);
    await userEvent.click(within(dialog).getByRole("button", { name: "Tout cocher" }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Tout décocher" }));
    expect(within(dialog).getByRole("button", { name: "Aucune feuille cochée" })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole("button", { name: "Annuler" }));
    expect(cancelWorkbook).toHaveBeenCalledOnce();
  });

  it("une erreur d'import se dit dans le dialogue, qui reste ouvert ; pendant l'envoi les boutons attendent", () => {
    const { rerender } = render(<DataView state={state({ pendingWorkbook: { file, sheets, error: "Serveur local injoignable." } })} />);
    expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent("Serveur local injoignable.");
    rerender(<DataView state={state({ pendingWorkbook: { file, sheets, error: null }, uploading: true })} />);
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Importer 2 feuilles" })).toBeDisabled();
    expect(within(screen.getByRole("dialog")).getByRole("button", { name: "Annuler" })).toBeDisabled();
  });

  it("les feuilles laissées de côté sont annoncées après l'import, sans être une erreur", async () => {
    const clearNotice = vi.fn();
    render(<DataView state={state({ notice: "2 feuilles importées. Laissée : « Notes » (Feuille vide : aucune donnée à importer).", clearNotice })} />);
    expect(screen.getByRole("status")).toHaveTextContent("Laissée : « Notes »");
    expect(screen.queryByRole("alert")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Fermer le message" }));
    expect(clearNotice).toHaveBeenCalledOnce();
  });

  /** L'écran branché sur le vrai état des jeux : dépôt du fichier → examen → choix → import. */
  function Screen() {
    return <DataView state={useDatasets()} />;
  }

  function server(listed: WorkbookSheet[]) {
    const calls: { url: string; sheets: string[] }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const form = init?.body instanceof FormData ? init.body : null;
        if (method === "POST") calls.push({ url: url.replace(/^.*\/api/, ""), sheets: form ? form.getAll("sheets").map(String) : [] });
        if (method === "POST" && url.endsWith("/datasets/sheets")) return json({ filename: "Budget 2026.xlsx", sheets: listed });
        if (method === "POST" && url.endsWith("/datasets/workbook")) {
          const wanted = form ? form.getAll("sheets").map(String) : [];
          return json({ datasets: wanted.map((n, i) => imported(n, `w${i}`)), skipped: [] }, 201);
        }
        if (method === "POST" && url.endsWith("/datasets")) return json({ ...profile, id: "seul", name: "Budget 2026.xlsx", format: "xlsx" }, 201);
        if (url.endsWith("/datasets")) return json([]);
        return json({ columns: [], rows: [], total: 0, offset: 0, limit: 100 });
      }),
    );
    return calls;
  }

  it("déposer un classeur à plusieurs feuilles ouvre le choix, puis importe un jeu par feuille cochée", async () => {
    const calls = server(sheets);
    render(<Screen />);
    await userEvent.upload(await screen.findByLabelText("Choisir un fichier de données"), file);
    const dialog = await screen.findByRole("dialog", { name: "Feuilles à importer" });
    // Rien n'est importé avant le choix.
    expect(calls.map((c) => c.url)).toEqual(["/datasets/sheets"]);
    await userEvent.click(within(dialog).getByRole("button", { name: "Importer 2 feuilles" }));
    const tabs = await screen.findByRole("tablist", { name: "Jeux de données" });
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Budget 2026 — Ventes", "Budget 2026 — Objectifs été"]);
    expect(within(tabs).getByRole("tab", { name: "Budget 2026 — Ventes" })).toHaveAttribute("aria-selected", "true");
    expect(calls[1]).toEqual({ url: "/datasets/workbook", sheets: ["Ventes", "Objectifs été"] });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("un classeur à une seule feuille s'importe comme avant, sans choix", async () => {
    const calls = server([sheets[0]!]);
    render(<Screen />);
    await userEvent.upload(await screen.findByLabelText("Choisir un fichier de données"), file);
    expect(await screen.findByRole("heading", { name: "Budget 2026.xlsx" })).toBeInTheDocument();
    expect(calls.map((c) => c.url)).toEqual(["/datasets/sheets", "/datasets"]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("un CSV n'a pas de feuilles : il part directement à l'import", async () => {
    const calls = server(sheets);
    render(<Screen />);
    await userEvent.upload(await screen.findByLabelText("Choisir un fichier de données"), new File(["a;b"], "ventes.csv"));
    await screen.findByRole("tablist", { name: "Jeux de données" });
    expect(calls.map((c) => c.url)).toEqual(["/datasets"]);
  });
});
