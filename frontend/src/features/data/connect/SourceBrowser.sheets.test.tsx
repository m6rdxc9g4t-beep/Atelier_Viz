import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { api } from "../../../lib/api";
import type { Connection, ImportRequest } from "../../../types/connection";
import type { DatasetProfile } from "../../../types/dataset";
import { SourceBrowser } from "./SourceBrowser";

const file: Connection = {
  id: "c1",
  name: "Budget partagé",
  kind: "file",
  host: null,
  port: null,
  database: null,
  username: null,
  encrypt: false,
  path: "/Users/moi/OneDrive/Budget 2026.xlsx",
  tenant: null,
  client_id: null,
  created_at: "2026-11-12T10:00:00Z",
  has_password: false,
  signed_in: false,
  account: null,
};

const profile = (name: string, sheet: string): DatasetProfile => ({
  id: `ds-${sheet}`,
  name,
  format: "xlsx",
  rows: 2,
  columns_count: 1,
  created_at: "2026-11-12T10:00:00Z",
  columns: [],
  sample: [],
  origin: { connection_id: "c1", connection_name: "Budget partagé", kind: "file", table: { name: sheet, kind: "sheet" }, query: null, url: null, project_id: null, max_rows: null, truncated: false, refreshed_at: "2026-11-12T10:00:00Z" },
});

const sheets = ["Ventes", "Notes", "Objectifs été"].map((name) => ({ name, kind: "sheet" as const }));

describe("connexion vers un classeur à plusieurs feuilles", () => {
  let requests: ImportRequest[];
  beforeEach(() => {
    requests = [];
    vi.spyOn(api.connections, "tables").mockResolvedValue({ tables: sheets, truncated: false, projects: [], location: null });
    vi.spyOn(api.connections, "preview").mockResolvedValue({ columns: ["a"], rows: [{ a: 1 }], truncated: false });
    vi.spyOn(api.connections, "import").mockImplementation(async (_id, body) => {
      requests.push(body);
      const sheet = body.table?.name ?? "";
      if (sheet === "Notes") throw new Error("Aucune donnée exploitable dans le fichier.");
      return profile(`Budget 2026 — ${sheet}`, sheet);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  function open(onImportedMany = vi.fn()) {
    render(<SourceBrowser connection={file} online={false} onEdit={vi.fn()} onChanged={vi.fn()} onImported={vi.fn()} onImportedMany={onImportedMany} />);
    return onImportedMany;
  }

  it("propose d'importer plusieurs feuilles : toutes cochées, une décochée n'est pas importée", async () => {
    const many = open();
    await userEvent.click(await screen.findByRole("button", { name: "Importer plusieurs feuilles…" }));
    const dialog = screen.getByRole("dialog", { name: "Feuilles à importer" });
    const boxes = within(dialog).getAllByRole("checkbox");
    expect(boxes).toHaveLength(3);
    for (const box of boxes) expect(box).toBeChecked();
    expect(within(dialog).getByText("Jeu « Budget 2026 — Objectifs été »")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /Notes/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "Importer 2 feuilles" }));
    await waitFor(() => expect(many).toHaveBeenCalledOnce());
    // Une demande par feuille, chacune avec sa feuille : l'origine du jeu la garde, « Actualiser » relit la bonne.
    // De la dernière à la première : la liste des jeux (le plus récent d'abord) suivra l'ordre du classeur.
    expect(requests.map((r) => r.table)).toEqual([sheets[2], sheets[0]]);
    const [profiles, complete] = many.mock.calls[0] as [DatasetProfile[], boolean];
    expect(profiles.map((p) => p.name)).toEqual(["Budget 2026 — Ventes", "Budget 2026 — Objectifs été"]);
    expect(profiles.map((p) => (p.origin && "table" in p.origin ? p.origin.table?.name : null))).toEqual(["Ventes", "Objectifs été"]);
    expect(complete).toBe(true);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("une feuille vide est signalée sans bloquer les autres ; le choix se referme, rien ne s'importe deux fois", async () => {
    const many = open();
    await userEvent.click(await screen.findByRole("button", { name: "Importer plusieurs feuilles…" }));
    const dialog = screen.getByRole("dialog", { name: "Feuilles à importer" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Importer 3 feuilles" }));
    await waitFor(() => expect(many).toHaveBeenCalledOnce());
    expect(requests).toHaveLength(3);
    const [profiles, complete] = many.mock.calls[0] as [DatasetProfile[], boolean];
    expect(profiles.map((p) => p.name)).toEqual(["Budget 2026 — Ventes", "Budget 2026 — Objectifs été"]);
    // Incomplet : le parcours de la source reste ouvert (`complete` faux) et dit quelle feuille manque, et pourquoi.
    expect(complete).toBe(false);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("2 feuilles importées. Laissée : « Notes » (Aucune donnée exploitable dans le fichier).");
  });

  it("un classeur à une seule feuille garde le parcours habituel", async () => {
    vi.spyOn(api.connections, "tables").mockResolvedValue({ tables: [sheets[0]!], truncated: false, projects: [], location: null });
    open();
    expect(await screen.findByRole("button", { name: "Ventes" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Importer plusieurs feuilles…" })).toBeNull();
  });
});
