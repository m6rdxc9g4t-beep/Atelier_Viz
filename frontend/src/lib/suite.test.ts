import { describe, expect, it, vi } from "vitest";

import { CURRENT_APP, HEALTH_TIMEOUT_MS, checkHealth, statusLabel, suiteApps } from "./suite";

describe("Suite Atelier : applications", () => {
  it("liste les trois applications avec les adresses du contrat", () => {
    const apps = suiteApps({});
    expect(apps.map((a) => [a.id, a.name, a.url])).toEqual([
      ["viz", "Atelier Viz", "http://127.0.0.1:8000"],
      ["tab", "Atelier Tab", "http://127.0.0.1:4175"],
      ["projets", "Atelier Projets", "http://127.0.0.1:4174"],
    ]);
    expect(CURRENT_APP).toBe("viz");
    // Seules les applications avec une API ont un état « en marche / arrêtée ».
    expect(apps.find((a) => a.id === "tab")?.healthUrl).toBeNull();
    expect(apps.find((a) => a.id === "projets")?.healthUrl).toBe("http://127.0.0.1:3000/api/health");
    expect(apps.every((a) => a.description.length > 0)).toBe(true);
  });

  it("applique les surcharges VITE_ATELIER_*_URL", () => {
    const apps = suiteApps({ VITE_ATELIER_TAB_URL: " http://localhost:5175/ ", VITE_ATELIER_PROJETS_URL: "", VITE_ATELIER_VIZ_URL: "http://127.0.0.1:9000" });
    expect(apps.map((a) => a.url)).toEqual(["http://127.0.0.1:9000", "http://localhost:5175", "http://127.0.0.1:4174"]);
  });

  it("libellés d'état", () => {
    expect(statusLabel("up")).toBe("en marche");
    expect(statusLabel("down")).toBe("arrêtée");
    expect(statusLabel("unknown")).toBe("vérification…");
  });
});

describe("Suite Atelier : état des API", () => {
  it("interroge /api/health en no-cors : une réponse (même opaque) = en marche", async () => {
    const fetcher = vi.fn(() => Promise.resolve(new Response(null, { status: 200 })));
    await expect(checkHealth("http://127.0.0.1:3000/api/health", HEALTH_TIMEOUT_MS, fetcher)).resolves.toBe("up");
    const init = (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.mode).toBe("no-cors");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("erreur réseau = arrêtée, sans lever", async () => {
    const fetcher = vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));
    await expect(checkHealth("http://127.0.0.1:3000/api/health", HEALTH_TIMEOUT_MS, fetcher)).resolves.toBe("down");
  });

  it("abandonne après le délai (1,5 s par défaut)", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(
        (_: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("abandon", "AbortError")))),
      );
      const pending = checkHealth("http://127.0.0.1:3000/api/health", undefined, fetcher as unknown as typeof fetch);
      await vi.advanceTimersByTimeAsync(HEALTH_TIMEOUT_MS);
      await expect(pending).resolves.toBe("down");
      expect(HEALTH_TIMEOUT_MS).toBe(1500);
    } finally {
      vi.useRealTimers();
    }
  });
});
