/** Client HTTP typé : seul point d'accès du front au backend FastAPI. */

import type { ChatRequest, ChatResponse, ClaudeModel, ProviderChoice, ProvidersResponse } from "../types/ai";
import type { BuildRequest, BuildResponse, RepairRequest, RepairResponse } from "../types/builder";
import type { AnswerRequest, AnswerResponse, SummaryRequest, SummaryResponse } from "../types/summary";
import type { DatasetModel, DatasetProfile, DatasetRows, DatasetSummary, ExpressionCheck, ExpressionResult, PrepPreview, PrepStep, Relation, RelationCheck, SampleFile, SamplesImport } from "../types/dataset";
import type { QueryRequest, QueryResponse } from "../types/query";
import type {
  AuthStatus,
  Connection,
  ConnectionInput,
  ConnectorInfo,
  DeviceCodeStart,
  ImportRequest,
  PreviewRequest,
  PreviewResult,
  TableList,
  TestResult,
} from "../types/connection";
import type { Alert, AlertInput, AlertNotification } from "../types/alert";
import type { GitHubConfigInput, GitHubState, GitHubTest, PullRequest, PullResult, PushRequest, PushResult, ReportVersion, ReportVersionDetail, RestoreRequest, RestoreResult } from "../types/github";
import type { RefreshRun, RefreshSchedule, ScheduleState } from "../types/refresh";
import type { Report, ReportBody, ReportSummary } from "../types/report";

/** Miroir de `Preferences` (backend/app/services/preferences.py). */
export interface Preferences {
  online_mode: boolean;
  /** Moteur choisi (« Auto · Ollama · Claude »), mémorisé. */
  ai_provider: ProviderChoice;
  claude_model: ClaudeModel;
  /** null = modèle Ollama de la configuration (`OLLAMA_MODEL`). */
  ollama_model: string | null;
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
    /** `detail` brut (objet structuré, ex. liste d'erreurs du modèle). */
    readonly detail?: unknown,
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
    const raw = body.detail;
    const message =
      typeof raw === "string"
        ? raw
        : raw && typeof raw === "object" && "message" in raw && typeof raw.message === "string"
          ? raw.message
          : `Erreur HTTP ${response.status}`;
    throw new ApiError(response.status, message, raw);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export const api = {
  health: () => request<{ status: "ok"; version: string; environment: string }>("/health"),
  /** `refresh` : revérifie Claude tout de suite (sinon état gardé 60 s par le serveur). */
  providers: (refresh = false) => request<ProvidersResponse>(`/ai/providers${refresh ? "?refresh=true" : ""}`),
  chat: (body: ChatRequest) => request<ChatResponse>("/ai/chat", { method: "POST", body: JSON.stringify(body) }),
  buildVisuals: (body: BuildRequest, signal?: AbortSignal) =>
    request<BuildResponse>("/ai/visuals", { method: "POST", body: JSON.stringify(body), signal }),
  /** Revalide des visuels de l'historique « Créer avec l'IA » (même `repair` que la génération). */
  repairVisuals: (body: RepairRequest) => request<RepairResponse>("/ai/visuals/repair", { method: "POST", body: JSON.stringify(body) }),
  summarizePage: (body: SummaryRequest, signal?: AbortSignal) =>
    request<SummaryResponse>("/ai/summary", { method: "POST", body: JSON.stringify(body), signal }),
  /** Réponse vérifiée à une question (ou explication d'un écart) à partir de faits calculés ici. */
  answer: (body: AnswerRequest, signal?: AbortSignal) => request<AnswerResponse>("/ai/answer", { method: "POST", body: JSON.stringify(body), signal }),

  samples: {
    list: () => request<SampleFile[]>("/samples"),
    /** Importe les exemples absents (jamais de doublon). */
    load: () => request<SamplesImport>("/samples", { method: "POST" }),
  },

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
    saveModel: (id: string, model: DatasetModel) =>
      request<DatasetProfile>(`/datasets/${id}/model`, { method: "PUT", body: JSON.stringify(model) }),
    /** Enregistre les étapes de préparation (appliquées à la source, rejouées à l'actualisation). */
    saveSteps: (id: string, steps: PrepStep[]) => request<DatasetProfile>(`/datasets/${id}/steps`, { method: "PUT", body: JSON.stringify({ steps }) }),
    /** Aperçu du résultat des étapes, sans rien enregistrer. */
    previewSteps: (id: string, steps: PrepStep[], signal?: AbortSignal) =>
      request<PrepPreview>(`/datasets/${id}/steps/preview`, { method: "POST", body: JSON.stringify({ steps }), signal }),
    /** Correspondance des clés d'une relation (lignes trouvées, doublons côté « un »). */
    checkRelation: (id: string, body: Relation, signal?: AbortSignal) =>
      request<RelationCheck>(`/datasets/${id}/relations/check`, { method: "POST", body: JSON.stringify(body), signal }),
    checkExpression: (id: string, body: ExpressionCheck, signal?: AbortSignal) =>
      request<ExpressionResult>(`/datasets/${id}/model/check`, { method: "POST", body: JSON.stringify(body), signal }),
    /** Relit la source d'un jeu importé depuis une connexion (même identifiant). */
    refresh: (id: string) => request<DatasetProfile>(`/datasets/${id}/refresh`, { method: "POST" }),
  },

  connections: {
    connectors: () => request<ConnectorInfo[]>("/connections/connectors"),
    list: () => request<Connection[]>("/connections"),
    create: (body: ConnectionInput) => request<Connection>("/connections", { method: "POST", body: JSON.stringify(body) }),
    update: (id: string, body: ConnectionInput) => request<Connection>(`/connections/${id}`, { method: "PUT", body: JSON.stringify(body) }),
    remove: (id: string) => request<void>(`/connections/${id}`, { method: "DELETE" }),
    /** Essai avant enregistrement. */
    testUnsaved: (body: ConnectionInput) => request<TestResult>("/connections/test", { method: "POST", body: JSON.stringify(body) }),
    test: (id: string) => request<TestResult>(`/connections/${id}/test`, { method: "POST" }),
    tables: (id: string, url?: string) => request<TableList>(`/connections/${id}/tables${url ? `?url=${encodeURIComponent(url)}` : ""}`),
    preview: (id: string, body: PreviewRequest, signal?: AbortSignal) =>
      request<PreviewResult>(`/connections/${id}/preview`, { method: "POST", body: JSON.stringify(body), signal }),
    import: (id: string, body: ImportRequest) => request<DatasetProfile>(`/connections/${id}/import`, { method: "POST", body: JSON.stringify(body) }),
    login: (id: string) => request<DeviceCodeStart>(`/connections/${id}/login`, { method: "POST" }),
    poll: (id: string) => request<AuthStatus>(`/connections/${id}/login/poll`, { method: "POST" }),
    logout: (id: string) => request<Connection>(`/connections/${id}/logout`, { method: "POST" }),
  },

  refresh: {
    list: () => request<ScheduleState[]>("/refresh"),
    get: (datasetId: string) => request<ScheduleState>(`/refresh/${datasetId}`),
    set: (datasetId: string, schedule: RefreshSchedule) =>
      request<ScheduleState>(`/refresh/${datasetId}`, { method: "PUT", body: JSON.stringify(schedule) }),
    /** Actualise tout de suite ; le résultat est aussi inscrit au journal. */
    run: (datasetId: string) => request<RefreshRun>(`/refresh/${datasetId}/run`, { method: "POST" }),
    /** Horodatage de la dernière actualisation de chaque jeu actualisable. */
    versions: () => request<Record<string, string>>("/refresh/versions"),
  },

  alerts: {
    list: (datasetId?: string) => request<Alert[]>(`/alerts${datasetId ? `?dataset_id=${datasetId}` : ""}`),
    /** Crée l'alerte et l'évalue une première fois. */
    create: (body: AlertInput) => request<Alert>("/alerts", { method: "POST", body: JSON.stringify(body) }),
    update: (id: string, body: AlertInput) => request<Alert>(`/alerts/${id}`, { method: "PUT", body: JSON.stringify(body) }),
    remove: (id: string) => request<void>(`/alerts/${id}`, { method: "DELETE" }),
    evaluate: (id: string) => request<Alert>(`/alerts/${id}/evaluate`, { method: "POST" }),
    /** Notifications système disponibles sur cette machine ? */
    system: () => request<{ available: boolean }>("/alerts/system"),
    testSystem: () => request<{ available: boolean }>("/alerts/system/test", { method: "POST" }),
    notifications: () => request<AlertNotification[]>("/alerts/notifications"),
    /** Liste vide = toutes. */
    markRead: (ids: string[] = []) =>
      request<AlertNotification[]>("/alerts/notifications/read", { method: "POST", body: JSON.stringify({ ids }) }),
  },

  github: {
    state: () => request<GitHubState>("/github"),
    configure: (body: GitHubConfigInput) => request<GitHubState>("/github", { method: "PUT", body: JSON.stringify(body) }),
    disconnect: () => request<GitHubState>("/github", { method: "DELETE" }),
    test: () => request<GitHubTest>("/github/test", { method: "POST" }),
    push: (body: PushRequest = {}) => request<PushResult>("/github/push", { method: "POST", body: JSON.stringify(body) }),
    pull: (body: PullRequest = {}) => request<PullResult>("/github/pull", { method: "POST", body: JSON.stringify(body) }),
    /** Commits qui ont modifié ce rapport (30 derniers). */
    history: (reportId: string) => request<ReportVersion[]>(`/github/reports/${reportId}/history`),
    version: (reportId: string, sha: string) => request<ReportVersionDetail>(`/github/reports/${reportId}/versions/${sha}`),
    /** Rétablit une version sur ce poste (ou l'importe en copie) ; rien n'est envoyé. */
    restore: (reportId: string, body: RestoreRequest) => request<RestoreResult>(`/github/reports/${reportId}/restore`, { method: "POST", body: JSON.stringify(body) }),
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
    /** Seuls les champs envoyés changent (les autres préférences sont gardées par le serveur). */
    set: (value: Partial<Preferences>) => request<Preferences>("/settings", { method: "PUT", body: JSON.stringify(value) }),
  },

  webhook: (url: string, method: "GET" | "POST", payload: Record<string, unknown>) =>
    request<WebhookResult>("/actions/webhook", { method: "POST", body: JSON.stringify({ url, method, payload }) }),
};
