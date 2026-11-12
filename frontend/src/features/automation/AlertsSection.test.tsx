import { act, render, screen, waitFor } from "@testing-library/react";

import { announceExamplesChange } from "../../lib/exemples";
import type { Alert } from "../../types/alert";
import type { DatasetSummary } from "../../types/dataset";
import { AlertsSection } from "./AlertsSection";
import { emptyAlert } from "./alerts";

const dataset = (id: string, name: string): DatasetSummary => ({ id, name, format: "json", rows: 3, columns_count: 2, created_at: "2026-10-19T10:00:00Z" });

const alert = (id: string, name: string, datasetId: string): Alert => ({
  ...emptyAlert(datasetId),
  name,
  id,
  created_at: "2026-10-19T10:00:00Z",
  met: null,
  last_value: null,
  last_evaluated_at: null,
  last_fired_at: null,
  history: [],
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

afterEach(() => vi.unstubAllGlobals());

describe("AlertsSection — exemples de la suite", () => {
  it("histoire retirée depuis le dialogue de la barre latérale : son alerte quitte la liste", async () => {
    const kept = alert("a1", "Ventes sous le seuil", "abc");
    const story = alert("a2", "Loyers en retard", "sci1");
    let removed = false;
    let alertLists = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/alerts")) {
          alertLists += 1;
          return json(removed ? [kept] : [kept, story]);
        }
        if (url.endsWith("/datasets")) return json(removed ? [dataset("abc", "ventes.csv")] : [dataset("abc", "ventes.csv"), dataset("sci1", "SCI Les Tilleuls — État locatif")]);
        return json({ available: false });
      }),
    );
    render(<AlertsSection />);
    expect(await screen.findByText("Loyers en retard")).toBeInTheDocument();
    expect(screen.getByText(/SCI Les Tilleuls — État locatif/)).toBeInTheDocument();
    expect(alertLists).toBe(1);

    removed = true;
    act(() => announceExamplesChange());
    await waitFor(() => expect(screen.queryByText("Loyers en retard")).toBeNull());
    expect(screen.queryByText(/SCI Les Tilleuls/)).toBeNull();
    expect(screen.getByText("Ventes sous le seuil")).toBeInTheDocument();
    expect(alertLists).toBe(2);
  });
});
