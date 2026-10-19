/** Miroir de backend/app/schemas/builder.py — garder synchronisé. */

import type { ProviderChoice, ProviderName } from "./ai";
import type { ColumnType } from "./dataset";
import type { FieldBinding, VisualType } from "./report";

export interface RoleSpec {
  id: string;
  label: string;
  kind: "dimension" | "measure";
  max?: number | null;
  required?: boolean;
  types?: ColumnType[] | null;
}

export interface OptionSpec {
  key: string;
  type: "boolean" | "select" | "number" | "text" | "textarea";
  choices?: string[] | null;
}

export interface VisualTypeSpec {
  type: VisualType;
  label: string;
  roles: RoleSpec[];
  options: OptionSpec[];
}

export interface BuildRequest {
  prompt: string;
  dataset_id: string;
  provider: ProviderChoice;
  catalog: VisualTypeSpec[];
  max_visuals?: number;
  existing?: string[];
}

export interface ProposedVisual {
  type: VisualType;
  title: string | null;
  roles: Record<string, FieldBinding[]>;
  options: Record<string, unknown>;
}

export interface BuildResponse {
  visuals: ProposedVisual[];
  explanation: string;
  provider: ProviderName;
  model: string;
  warnings: string[];
}
