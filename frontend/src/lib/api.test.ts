import { ApiError, api } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("api", () => {
  it("transmet le detail FastAPI dans ApiError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: "Ollama injoignable" }), { status: 503 })),
    );
    await expect(api.providers()).rejects.toEqual(new ApiError(503, "Ollama injoignable"));
  });

  it("explique quand le backend ne répond pas", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(api.health()).rejects.toThrow(/uvicorn/);
  });
});
