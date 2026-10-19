/** Client HTTP typé : seul point d'accès du front au backend FastAPI. */

import type { ChatRequest, ChatResponse, ProvidersResponse } from "../types/ai";
import type { DatasetProfile, DatasetRows, DatasetSummary } from "../types/dataset";
import type { QueryRequest, QueryResponse } from "../types/query";
import type { Report, ReportBody, ReportSummary } from "../types/report";

export interface Preferences {
  online_mode: boolean;
}

export interface WebhookResult {
  status_code: number;
  ok: boolean;
  body: string;
}

/** Erreur renvoyée par l'API, avec le message `detail` de FastAPI. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // JSON par défaut ; pour un FormData, le navigateur pose lui-même l'en-tête multipart.
  const headers = typeof init?.body === "string" ? { "Content-Type": "application/json" } : undefined;
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { ...init, headers: { ...headers, ...init?.headers } });
  } catch {
    throw new ApiError(0, "Backend injoignable — lancez `uvicorn main:app --reload` dans backend/.");
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { detail?: unknown };
    const detail = typeof body.detail === "string" ? body.detail : `Erreur HTTP ${response.status}`;
    throw new ApiError(response.status, detail);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  health: () => request<{ status: "ok"; version: string; environment: string }>("/health"),
  providers: () => request<ProvidersResponse>("/ai/providers"),
  chat: (body: ChatRequest) => request<ChatResponse>("/ai/chat", { method: "POST", body: JSON.stringify(body) }),

  datasets: {
    list: () => request<DatasetSummary[]>("/datasets"),
    get: (id: string) => request<DatasetProfile>(`/datasets/${id}`),
    rows: (id: string, offset = 0, limit = 100) =>
      request<DatasetRows>(`/datasets/${id}/rows?offset=${offset}&limit=${limit}`),
    upload: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return request<DatasetProfile>("/datasets", { method: "POST", body: form });
    },
    remove: (id: string) => request<void>(`/datasets/${id}`, { method: "DELETE" }),
  },

  query: (body: QueryRequest, signal?: AbortSignal) =>
    request<QueryResponse>("/query", { method: "POST", body: JSON.stringify(body), signal }),

  reports: {
    list: () => request<ReportSummary[]>("/reports"),
    get: (id: string) => request<Report>(`/reports/${id}`),
    create: (name: string, datasetId?: string | null) =>
      request<Report>("/reports", { method: "POST", body: JSON.stringify({ name, dataset_id: datasetId ?? null }) }),
    save: (id: string, body: ReportBody) =>
      request<Report>(`/reports/${id}`, { method: "PUT", body: JSON.stringify(body) }),
    remove: (id: string) => request<void>(`/reports/${id}`, { method: "DELETE" }),
  },

  settings: {
    get: () => request<Preferences>("/settings"),
    set: (value: Preferences) => request<Preferences>("/settings", { method: "PUT", body: JSON.stringify(value) }),
  },

  webhook: (url: string, method: "GET" | "POST", payload: Record<string, unknown>) =>
    request<WebhookResult>("/actions/webhook", { method: "POST", body: JSON.stringify({ url, method, payload }) }),
};
