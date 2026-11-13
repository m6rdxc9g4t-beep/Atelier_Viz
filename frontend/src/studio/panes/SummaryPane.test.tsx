import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { resetPreferencesCache } from "../../hooks/usePreferences";
import { resetProvidersCache } from "../../hooks/useProviders";
import { api } from "../../lib/api";
import * as pageSummary from "../../summary/pageSummary";
import type { Report } from "../../types/report";
import type { SummaryResponse } from "../../types/summary";
import { useStudio } from "../store";
import { SummaryPane } from "./SummaryPane";

const report: Report = {
  id: "r1",
  name: "Exemple — Studio Garance",
  pages: [{ id: "p1", name: "Trésorerie", size: { width: 1280, height: 720 }, visuals: [], filters: [] }],
} as unknown as Report;

const brief: pageSummary.PageBrief = {
  visuals: [
    { id: "rec", title: "Recettes", type: "kpi", facts: ["Recettes : 13 k €"] },
    { id: "dep", title: "Dépenses", type: "kpi", facts: ["Dépenses : 9,1 k €"] },
  ],
  reading: {
    headline: "Trésorerie : Recettes 13 k €, Dépenses 9,1 k €.",
    period: null,
    points: [{ text: "« Dépenses » (9,1 k €) représente 70 % de « Recettes » (13 k €).", visuals: ["dep", "rec"] }],
  },
};

const answer = (patch: Partial<SummaryResponse>): SummaryResponse => ({
  headline: "Les recettes couvrent largement les dépenses.",
  points: [{ text: "Les dépenses pèsent 70 % des recettes.", visuals: ["dep", "rec"] }],
  provider: "ollama",
  model: "llama3.2:3b",
  warnings: [],
  ...patch,
});

describe("volet « Résumé de la page »", () => {
  beforeEach(() => {
    resetPreferencesCache();
    resetProvidersCache();
    useStudio.getState().load(structuredClone(report));
    vi.spyOn(api.settings, "get").mockResolvedValue({ online_mode: false, ai_provider: "auto", claude_model: "sonnet", ollama_model: null });
    vi.spyOn(api, "providers").mockResolvedValue({ providers: [{ name: "ollama", available: true, model: "llama3.2:3b", detail: null, models: ["llama3.2:3b"] }] });
    vi.spyOn(pageSummary, "loadPageBrief").mockResolvedValue(brief);
  });

  async function summarize(response: SummaryResponse) {
    const send = vi.spyOn(api, "summarizePage").mockResolvedValue(response);
    render(<SummaryPane />);
    await userEvent.click(await screen.findByRole("button", { name: "Résumer la page" }));
    return { send, article: await screen.findByRole("article", { name: "Synthèse de la page" }) };
  }

  it("envoie les faits et la lecture calculée, et montre ce qui part", async () => {
    const { send, article } = await summarize(answer({}));
    expect(send.mock.calls[0]?.[0]).toMatchObject({ page: "Trésorerie", visuals: brief.visuals, reading: brief.reading, max_points: 4 });
    // 2 faits de cartes + 1 constat calculé : tout ce qui part est compté et consultable.
    expect(screen.getByText(/Seuls 3 constats chiffrés de 2 visuels sont envoyés, aucune ligne de données/)).toBeInTheDocument();
    expect(screen.getByText("Lecture calculée de la page")).toBeInTheDocument();
    expect(within(article).getByText("Les recettes couvrent largement les dépenses.")).toBeInTheDocument();
    expect(screen.getByText("Synthèse · Ollama")).toBeInTheDocument();
    expect(within(article).getAllByRole("button", { name: /Dépenses|Recettes/ })).toHaveLength(2); // chaque point relié à ses visuels
  });

  it("modèle en échec : la lecture calculée s'affiche, dite sans IA, avec la raison", async () => {
    const reason = "Ollama n'a pas répondu (Ollama injoignable) : lecture calculée sur cette machine, sans IA.";
    const { article } = await summarize(
      answer({ headline: brief.reading?.headline ?? "", points: [{ text: brief.reading?.points[0]?.text ?? "", visuals: ["dep", "rec"], local: true }], model: "", warnings: [reason], local: true }),
    );
    expect(screen.getByText("Synthèse · calculée sans IA")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(reason);
    expect(within(article).getByText(/représente 70 % de/)).toBeInTheDocument();
    expect(screen.getByText(/aucune phrase ne vient d'une IA/)).toBeInTheDocument();
    expect(screen.queryByText("calculé sans IA")).not.toBeInTheDocument(); // dit une fois, pas sur chaque point
  });

  it("phrase écartée : le constat calculé qui la remplace est marqué", async () => {
    const { article } = await summarize(
      answer({
        points: [
          { text: "Les dépenses pèsent 70 % des recettes.", visuals: ["dep"] },
          { text: "« Dépenses » (9,1 k €) représente 70 % de « Recettes » (13 k €).", visuals: ["rec"], local: true },
        ],
        warnings: ["Point écarté (chiffre non vérifiable : 75 %) : Les ventes bondissent de 75 %."],
      }),
    );
    expect(within(article).getAllByText("calculé sans IA")).toHaveLength(1);
    expect(screen.getByText("1 élément(s) écarté(s)")).toBeInTheDocument();
    expect(screen.getByText("Synthèse · Ollama")).toBeInTheDocument();
  });
});
