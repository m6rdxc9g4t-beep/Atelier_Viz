import config from "../../vite.config";

describe("serveur de développement (docs/SUITE.md §2)", () => {
  it("écoute sur 127.0.0.1:5173 avec un port strict et relaie /api vers FastAPI", () => {
    const server = config.server;
    expect(server?.host).toBe("127.0.0.1");
    expect(server?.port).toBe(5173);
    expect(server?.strictPort).toBe(true);
    expect(server?.proxy).toEqual({ "/api": "http://localhost:8000" });
  });
});
