/** Miroir de backend/app/schemas/ai.py — garder synchronisé. */

export type ProviderName = "ollama" | "anthropic";
export type ProviderChoice = "auto" | ProviderName;
export type TaskComplexity = "simple" | "complex";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  system?: string | null;
  provider?: ProviderChoice;
  task?: TaskComplexity;
  /** Le schéma et un échantillon de ce jeu de données sont transmis à l'IA. */
  dataset_id?: string | null;
}

export interface ChatResponse {
  provider: ProviderName;
  model: string;
  content: string;
  fallback_used: boolean;
}

export interface ProviderStatus {
  name: ProviderName;
  available: boolean;
  model: string;
  detail: string | null;
  models: string[];
}

export interface ProvidersResponse {
  providers: ProviderStatus[];
}
