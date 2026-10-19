import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { ProviderStatus } from "../../types/ai";
import { ProviderBadges } from "./ProviderBadges";

const providers: ProviderStatus[] = [
  { name: "ollama", available: true, model: "llama3.2", detail: null, models: ["llama3.2:latest"] },
  { name: "anthropic", available: false, model: "claude-sonnet-5-5", detail: "Clé absente", models: [] },
];

describe("ProviderBadges", () => {
  it("affiche l'état de chaque fournisseur", () => {
    render(<ProviderBadges providers={providers} loading={false} error={null} onRefresh={() => {}} />);
    expect(screen.getByText("Ollama")).toHaveTextContent("disponible");
    expect(screen.getByText("Claude")).toHaveTextContent("indisponible");
    expect(screen.getByText("Claude")).toHaveAttribute("title", "Clé absente");
  });

  it("signale une API hors ligne et permet de revérifier", async () => {
    const onRefresh = vi.fn();
    render(<ProviderBadges providers={[]} loading={false} error="Backend injoignable" onRefresh={onRefresh} />);
    expect(screen.getByText("API hors ligne")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /revérifier/i }));
    expect(onRefresh).toHaveBeenCalledOnce();
  });
});
