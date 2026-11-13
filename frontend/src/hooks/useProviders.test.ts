import { act, renderHook, waitFor } from "@testing-library/react";

import { ApiError, api } from "../lib/api";
import type { ProviderStatus } from "../types/ai";
import { resetProvidersCache, useProviders } from "./useProviders";

const REFUSED = "Le jeton du forfait Claude est refusé ou expiré : refaites « claude setup-token » sur votre ordinateur et mettez à jour le jeton du serveur (CLAUDE_OAUTH_TOKEN), puis redémarrez Atelier Viz.";
const ollama: ProviderStatus = { name: "ollama", available: true, model: "llama3.2", detail: null, models: ["llama3.2"] };
const byToken: ProviderStatus = { name: "anthropic", available: true, model: "sonnet (CLI)", detail: "Forfait Claude, par jeton", models: ["sonnet", "opus", "haiku"], access: "token" };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Faux serveur : l'état des moteurs change quand Claude refuse le jeton ; chaque adresse demandée est notée. */
function fakeServer(chatStatus: number, chatDetail: string) {
  const asked: string[] = [];
  let claude = byToken;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      asked.push(url);
      if (url.startsWith("/api/ai/providers")) return json({ providers: [ollama, claude] });
      if (chatStatus === 503) claude = { ...byToken, available: false, detail: chatDetail };
      return json({ detail: chatDetail }, chatStatus);
    }),
  );
  return asked;
}

const chat = () => api.chat({ messages: [{ role: "user", content: "Bonjour" }], provider: "auto" }).catch((e: unknown) => e);

beforeEach(() => resetProvidersCache());
afterEach(() => vi.unstubAllGlobals());

describe("useProviders — état relu après le refus d'un moteur", () => {
  it("jeton du forfait refusé (503) : la pastille s'éteint sans attendre « Revérifier », et sans forcer", async () => {
    const asked = fakeServer(503, REFUSED);
    const { result } = renderHook(() => useProviders());
    await waitFor(() => expect(result.current.providers).toHaveLength(2));
    expect(result.current.providers[1]).toMatchObject({ available: true, access: "token" });

    const err = (await act(chat)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe(REFUSED); // l'erreur suit son cours : le volet l'affiche
    await waitFor(() => expect(result.current.providers[1]).toMatchObject({ available: false, detail: REFUSED }));
    // Une seule relecture, non forcée : « ?refresh=true » redonnerait sa chance au jeton refusé.
    expect(asked).toEqual(["/api/ai/providers", "/api/ai/chat", "/api/ai/providers"]);
  });

  it("limite du forfait (429) ou refus hors ligne (403) : l'état n'est pas relu", async () => {
    for (const status of [429, 403]) {
      resetProvidersCache();
      const asked = fakeServer(status, "Limite du forfait Claude atteinte");
      const { result, unmount } = renderHook(() => useProviders());
      await waitFor(() => expect(result.current.providers).toHaveLength(2));
      expect(((await act(chat)) as ApiError).status).toBe(status);
      expect(asked).toEqual(["/api/ai/providers", "/api/ai/chat"]);
      expect(result.current.providers[1]).toMatchObject({ available: true });
      unmount();
    }
  });

  it("aucun écran ne montre l'état des moteurs : rien n'est demandé", async () => {
    const asked = fakeServer(503, REFUSED);
    expect(((await chat()) as ApiError).status).toBe(503);
    expect(asked).toEqual(["/api/ai/chat"]);
  });
});
