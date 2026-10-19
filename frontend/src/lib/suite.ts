/**
 * Suite Atelier : adresses des trois applications et état de leurs API (docs/SUITE.md §2 et §3).
 *
 * Les adresses sont celles de l'interface « aperçu / app » ; chacune se surcharge par une variable
 * d'environnement Vite (`VITE_ATELIER_VIZ_URL`, `VITE_ATELIER_TAB_URL`, `VITE_ATELIER_PROJETS_URL`).
 */

export type SuiteAppId = "viz" | "tab" | "projets";

/** Une application de la suite, telle que le sélecteur l'affiche. */
export interface SuiteApp {
  id: SuiteAppId;
  name: string;
  description: string;
  /** Adresse ouverte au clic (interface servie, ou app de bureau). */
  url: string;
  /** Adresse de `GET /api/health`, pour les applications qui ont une API ; sinon null. */
  healthUrl: string | null;
}

/** État affiché à côté d'une application : en marche, arrêtée, ou pas encore connu. */
export type SuiteStatus = "unknown" | "up" | "down";

/** Délai maximal d'une vérification d'état (docs/SUITE.md §3). */
export const HEALTH_TIMEOUT_MS = 1500;

/** Application courante (cochée dans le menu). */
export const CURRENT_APP: SuiteAppId = "viz";

const DEFAULTS: Record<SuiteAppId, string> = {
  viz: "http://127.0.0.1:8000",
  tab: "http://127.0.0.1:4175",
  projets: "http://127.0.0.1:4174",
};

/** API d'Atelier Projets (docs/SUITE.md §2). */
export const PROJETS_API = "http://127.0.0.1:3000";

/** Variables d'environnement utiles (sous-ensemble de `import.meta.env`). */
export interface SuiteEnv {
  VITE_ATELIER_VIZ_URL?: string;
  VITE_ATELIER_TAB_URL?: string;
  VITE_ATELIER_PROJETS_URL?: string;
}

const clean = (url: string | undefined, fallback: string) => (url && url.trim() ? url.trim().replace(/\/+$/, "") : fallback);

/** Les trois applications, dans l'ordre du menu, avec les surcharges d'environnement appliquées. */
export function suiteApps(env: SuiteEnv = import.meta.env as SuiteEnv): SuiteApp[] {
  return [
    {
      id: "viz",
      name: "Atelier Viz",
      description: "BI locale : rapports, visuels, IA",
      url: clean(env.VITE_ATELIER_VIZ_URL, DEFAULTS.viz),
      // Application courante : sa propre API, sur la même origine (proxy Vite en développement, port libre dans l'app).
      healthUrl: "/api/health",
    },
    {
      id: "tab",
      name: "Atelier Tab",
      description: "Tableur et base typée",
      url: clean(env.VITE_ATELIER_TAB_URL, DEFAULTS.tab),
      healthUrl: null,
    },
    {
      id: "projets",
      name: "Atelier Projets",
      description: "Projets agiles, Git, temps passé",
      url: clean(env.VITE_ATELIER_PROJETS_URL, DEFAULTS.projets),
      healthUrl: `${PROJETS_API}/api/health`,
    },
  ];
}

/** Libellé d'état lisible (lecteurs d'écran et info-bulle). */
export function statusLabel(status: SuiteStatus): string {
  return status === "up" ? "en marche" : status === "down" ? "arrêtée" : "vérification…";
}

/**
 * Vérifie qu'une API répond, sans jamais lever : `fetch` en `mode: "no-cors"` (réponse opaque, mais
 * une réponse = serveur en marche), abandon après `timeoutMs`.
 */
export async function checkHealth(url: string, timeoutMs = HEALTH_TIMEOUT_MS, fetcher: typeof fetch = fetch): Promise<Exclude<SuiteStatus, "unknown">> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    await fetcher(url, { mode: "no-cors", cache: "no-store", signal: ctrl.signal });
    return "up";
  } catch {
    return "down";
  } finally {
    clearTimeout(timer);
  }
}
