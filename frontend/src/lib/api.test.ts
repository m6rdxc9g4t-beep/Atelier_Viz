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
    await expect(api.health()).rejects.toThrow(/uvicorn/);
  });
});
