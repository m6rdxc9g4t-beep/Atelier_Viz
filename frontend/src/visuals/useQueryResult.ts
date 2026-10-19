/** Exécution des requêtes des visuels, avec cache partagé et déduplication. */

import { useEffect, useState } from "react";

import { api } from "../lib/api";
import type { Scalar } from "../types/dataset";
import type { QueryColumn, QueryRequest, QueryResponse } from "../types/query";

export type Row = Record<string, Scalar>;

export interface QueryResult {
  columns: QueryColumn[];
  rows: Row[];
  truncated: boolean;
}

interface State {
  result: QueryResult | null;
  loading: boolean;
  error: string | null;
}

const MAX_ENTRIES = 300;
const cache = new Map<string, Promise<QueryResult>>();

export function toRecords(res: QueryResponse): QueryResult {
  const keys = res.columns.map((c) => c.key);
  return {
    columns: res.columns,
    truncated: res.truncated,
    rows: res.rows.map((r) => Object.fromEntries(keys.map((k, i) => [k, r[i] ?? null]))),
  };
}

/** Lance (ou réutilise) une requête. Les échecs ne restent pas en cache. */
export function runQuery(req: QueryRequest): Promise<QueryResult> {
  const key = JSON.stringify(req);
  const hit = cache.get(key);
  if (hit) return hit;
  const promise = api.query(req).then(toRecords);
  cache.set(key, promise);
  promise.catch(() => cache.delete(key));
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return promise;
}

const invalidated = new Set<(datasetId?: string) => void>();

/** À appeler quand un jeu de données change (actualisation, réimport, suppression) : les visuels affichés se rechargent. */
export function invalidateQueries(datasetId?: string): void {
  for (const key of cache.keys()) {
    if (!datasetId || key.includes(`"dataset_id":"${datasetId}"`)) cache.delete(key);
  }
  invalidated.forEach((listener) => listener(datasetId));
}

/** Résultat d'une requête ; `null` = visuel pas encore configuré. */
export function useQueryResult(req: QueryRequest | null): State {
  const key = req ? JSON.stringify(req) : null;
  const [state, setState] = useState<State>({ result: null, loading: req !== null, error: null });
  // Incrémenté quand les données du jeu changent : la même requête est relancée.
  const [version, setVersion] = useState(0);
  const datasetId = req?.dataset_id;

  useEffect(() => {
    const listener = (id?: string) => {
      if (!id || id === datasetId) setVersion((v) => v + 1);
    };
    invalidated.add(listener);
    return () => {
      invalidated.delete(listener);
    };
  }, [datasetId]);

  useEffect(() => {
    if (!key) {
      setState({ result: null, loading: false, error: null });
      return;
    }
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    runQuery(JSON.parse(key) as QueryRequest)
      .then((result) => alive && setState({ result, loading: false, error: null }))
      .catch((err: unknown) => {
        if (alive) setState({ result: null, loading: false, error: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      alive = false;
    };
  }, [key, version]);

  return state;
}
