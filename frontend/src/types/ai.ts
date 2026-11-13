/** Miroir de backend/app/schemas/ai.py — garder synchronisé. */

export type ProviderName = "ollama" | "anthropic";
export type ProviderChoice = "auto" | ProviderName;
export type TaskComplexity = "simple" | "complex";
/** Modèles Claude proposés (alias de la CLI, docs/SUITE.md §5.2). */
export type ClaudeModel = "sonnet" | "opus" | "haiku";
/** Accès à Claude : session `claude` de l'utilisateur, jeton du forfait (`CLAUDE_OAUTH_TOKEN`) ou clé API. */
export type ClaudeAccess = "cli" | "token" | "api";

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
  /** Modèles au choix : installés (Ollama) ou sonnet / opus / haiku (CLI Claude). */
  models: string[];
  /** Version de la CLI Claude. */
  version?: string | null;
  /** Chemin de l'exécutable `claude` trouvé. */
  executable?: string | null;
  /** Claude seulement : par où il répond. En mode `token`, le jeton lui-même n'est jamais renvoyé. */
  access?: ClaudeAccess | null;
}

export interface ProvidersResponse {
  providers: ProviderStatus[];
}
