import { ApiError, api } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("api", () => {
  it("transmet le detail FastAPI dans ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "Ollama injoignable" }), { status: 503 })),
    );
    await expect(api.providers()).rejects.toEqual(new ApiError(503, "Ollama injoignable", "Ollama injoignable"));
  });

  it("garde le detail structuré (erreurs du modèle) et en tire le message", async () => {
    const detail = { message: "Le modèle contient des erreurs.", issues: [{ kind: "measure", name: "m", error: "x" }] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail }), { status: 422 })));
    const err = (await api.datasets.saveModel("abc", { columns: [], measures: [] }).catch((e: unknown) => e)) as ApiError;
    expect(err.message).toBe("Le modèle contient des erreurs.");
    expect(err.detail).toEqual(detail);
  });

  it("explique quand le backend ne répond pas", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const err = (await api.health().catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/relancez l'application/);
  });

  it("laisse passer une annulation : ce n'est pas un serveur injoignable", async () => {
    // fetch rejette avec « AbortError » quand le signal est annulé (bouton « Arrêter », aperçu remplacé par le suivant).
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("The user aborted a request.", "AbortError"))))),
    );
    const ctrl = new AbortController();
    const pending = api.query({ dataset_id: "abc" } as never, ctrl.signal).catch((e: unknown) => e);
    ctrl.abort();
    const err = (await pending) as Error;
    expect(err.name).toBe("AbortError");
    expect(err).not.toBeInstanceOf(ApiError);
  });

  it("traite en annulation un échec de fetch dont le signal est annulé", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    const err = (await api.query({ dataset_id: "abc" } as never, ctrl.signal).catch((e: unknown) => e)) as Error;
    expect(err.name).toBe("AbortError");
  });
});
