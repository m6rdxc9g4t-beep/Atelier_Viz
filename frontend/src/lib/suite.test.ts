import { describe, expect, it, vi } from "vitest";

import { CURRENT_APP, HEALTH_TIMEOUT_MS, TAB_HEALTH_URLS, checkAnyHealth, checkHealth, statusLabel, suiteApps, tabHealthUrls } from "./suite";

describe("Suite Atelier : applications", () => {
  it("liste les quatre applications avec les adresses du contrat", () => {
    const apps = suiteApps({});
    expect(apps.map((a) => [a.id, a.name, a.url])).toEqual([
      ["viz", "Atelier Viz", "http://127.0.0.1:8000"],
      ["tab", "Atelier Tab", "http://127.0.0.1:4175"],
      ["projets", "Atelier Projets", "http://127.0.0.1:4174"],
      ["cuisine", "Atelier Cuisine", "https://atelier-cuisine-iota.vercel.app"],
    ]);
    expect(CURRENT_APP).toBe("viz");
    // Atelier Cuisine : app en ligne, jamais sondée (docs/SUITE.md §3).
    expect(apps.find((a) => a.id === "cuisine")).toMatchObject({ healthUrls: [], online: true, short: "Cuisine" });
    expect(apps.filter((a) => a.online).map((a) => a.id)).toEqual(["cuisine"]);
    // Les trois ont un état « en marche / arrêtée » ; Tab expose seulement sa route de santé (docs/SUITE.md §3).
    expect(apps.find((a) => a.id === "tab")?.healthUrls).toEqual(["http://127.0.0.1:4175/api/health", "http://127.0.0.1:5175/api/health"]);
    expect(apps.find((a) => a.id === "projets")?.healthUrls).toEqual(["http://127.0.0.1:3000/api/health"]);
    expect(apps.find((a) => a.id === "viz")?.healthUrls).toEqual(["/api/health"]);
    expect(apps.every((a) => a.description.length > 0)).toBe(true);
  });

  it("applique les surcharges VITE_ATELIER_*_URL", () => {
    const apps = suiteApps({
      VITE_ATELIER_TAB_URL: " http://localhost:5175/ ",
      VITE_ATELIER_PROJETS_URL: "",
      VITE_ATELIER_VIZ_URL: "http://127.0.0.1:9000",
      VITE_ATELIER_CUISINE_URL: "https://cuisine.example.org/",
    });
    expect(apps.map((a) => a.url)).toEqual(["http://127.0.0.1:9000", "http://localhost:5175", "http://127.0.0.1:4174", "https://cuisine.example.org"]);
  });

  it("dérive la santé d'Atelier Tab de VITE_ATELIER_TAB_URL (comme Projets), sans doublon", () => {
    expect(tabHealthUrls({})).toEqual(["http://127.0.0.1:4175/api/health", "http://127.0.0.1:5175/api/health"]);
    const custom = suiteApps({ VITE_ATELIER_TAB_URL: "http://127.0.0.1:4999/" });
    expect(custom.find((a) => a.id === "tab")?.healthUrls).toEqual(["http://127.0.0.1:4999/api/health", "http://127.0.0.1:5175/api/health"]);
    expect(tabHealthUrls({ VITE_ATELIER_TAB_URL: "http://127.0.0.1:5175" })).toEqual(["http://127.0.0.1:5175/api/health"]);
  });

  it("libellés d'état", () => {
    expect(statusLabel("up")).toBe("En marche");
    expect(statusLabel("down")).toBe("Arrêtée");
    expect(statusLabel("unknown")).toBe("Vérification…");
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

describe("Suite Atelier : Atelier Tab sur 4175 puis 5175", () => {
  const answering = (up: string[]) =>
    vi.fn((url: string) => (up.includes(url) ? Promise.resolve(new Response(null, { status: 200 })) : Promise.reject(new TypeError("Failed to fetch"))));

  it("app de bureau ou aperçu (4175) : en marche", async () => {
    const fetcher = answering([TAB_HEALTH_URLS[0]!]);
    await expect(checkAnyHealth(TAB_HEALTH_URLS, HEALTH_TIMEOUT_MS, fetcher as unknown as typeof fetch)).resolves.toBe("up");
  });

  it("npm run dev seulement (5175) : en marche", async () => {
    const fetcher = answering([TAB_HEALTH_URLS[1]!]);
    await expect(checkAnyHealth(TAB_HEALTH_URLS, HEALTH_TIMEOUT_MS, fetcher as unknown as typeof fetch)).resolves.toBe("up");
    // Les deux adresses sont sondées, dans l'ordre du contrat, en no-cors.
    expect(fetcher.mock.calls.map((c) => c[0])).toEqual(TAB_HEALTH_URLS);
    expect((fetcher.mock.calls[1] as unknown as [string, RequestInit])[1].mode).toBe("no-cors");
  });

  it("aucune ne répond : arrêtée ; liste vide : arrêtée", async () => {
    await expect(checkAnyHealth(TAB_HEALTH_URLS, HEALTH_TIMEOUT_MS, answering([]) as unknown as typeof fetch)).resolves.toBe("down");
    await expect(checkAnyHealth([], HEALTH_TIMEOUT_MS, answering([]) as unknown as typeof fetch)).resolves.toBe("down");
  });

  it("délai total de 1,5 s même si les deux adresses pendent", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(
        (_: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("abandon", "AbortError")))),
      );
      const pending = checkAnyHealth(TAB_HEALTH_URLS, undefined, fetcher as unknown as typeof fetch);
      await vi.advanceTimersByTimeAsync(HEALTH_TIMEOUT_MS);
      await expect(pending).resolves.toBe("down");
    } finally {
      vi.useRealTimers();
    }
  });
});
