import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { DatasetsState } from "../../hooks/useDatasets";
import { formatValue } from "../../lib/format";
import type { DatasetProfile } from "../../types/dataset";
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
