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
  /** Nom accessible (« Atelier Viz »). */
  name: string;
  /** Nom affiché après « atelier_ » dans la marque (docs/SUITE.md §1.6). */
  short: string;
  description: string;
  /** Adresse ouverte au clic (interface servie, ou app de bureau). */
  url: string;
  /**
   * Adresses de `GET /api/health` à sonder (docs/SUITE.md §3) : l'application est « en marche » si
   * l'une d'elles répond. Vide = pas d'indicateur.
   */
  healthUrls: string[];
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

/**
 * Santé d'Atelier Tab (docs/SUITE.md §2 et §3) : app de bureau ou aperçu (4175), puis `npm run dev` (5175).
 * Tab n'a pas d'API de données, seulement cette route.
 */
export const TAB_HEALTH_URLS = ["http://127.0.0.1:4175/api/health", "http://127.0.0.1:5175/api/health"];

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
      short: "Viz",
      description: "BI locale : rapports, visuels, IA",
      url: clean(env.VITE_ATELIER_VIZ_URL, DEFAULTS.viz),
      // Application courante : sa propre API, sur la même origine (proxy Vite en développement, port libre dans l'app).
      healthUrls: ["/api/health"],
    },
    {
      id: "tab",
      name: "Atelier Tab",
      short: "Tab",
      description: "Tableur et base de données typée",
      url: clean(env.VITE_ATELIER_TAB_URL, DEFAULTS.tab),
      healthUrls: TAB_HEALTH_URLS,
    },
    {
      id: "projets",
      name: "Atelier Projets",
      short: "Projets",
      description: "Projets agiles, Git, temps passé",
      url: clean(env.VITE_ATELIER_PROJETS_URL, DEFAULTS.projets),
      healthUrls: [`${PROJETS_API}/api/health`],
    },
  ];
}

/** Libellé d'état lisible (lecteurs d'écran et info-bulle). */
export function statusLabel(status: SuiteStatus): string {
  return status === "up" ? "En marche" : status === "down" ? "Arrêtée" : "Vérification…";
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

/**
 * Sonde plusieurs adresses de santé (dans l'ordre, en parallèle) : « en marche » dès que l'une répond,
 * « arrêtée » si aucune ne répond dans le délai. Le temps total ne dépasse donc pas `timeoutMs`.
 */
export async function checkAnyHealth(urls: string[], timeoutMs = HEALTH_TIMEOUT_MS, fetcher: typeof fetch = fetch): Promise<Exclude<SuiteStatus, "unknown">> {
  if (!urls.length) return "down";
  const results = urls.map((url) => checkHealth(url, timeoutMs, fetcher).then((st) => (st === "up" ? Promise.resolve("up" as const) : Promise.reject(new Error(url)))));
  try {
    return await Promise.any(results);
  } catch {
    return "down";
  }
}
