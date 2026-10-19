/** Contrat commun à tous les types de visuels (registre extensible). */

import type { LucideIcon } from "lucide-react";
import type { ComponentType } from "react";

import type { ColumnType, DatasetProfile, Scalar } from "../types/dataset";
import type { Filter, QueryRequest } from "../types/query";
import type { Page, Visual, VisualOptions, VisualType } from "../types/report";
import type { QueryResult } from "./useQueryResult";

export interface RoleDef {
  id: string;
  label: string;
  kind: "dimension" | "measure";
  /** Nombre maximal de champs (défaut : illimité). */
  max?: number;
  /** Types de colonnes acceptés (défaut : tous). */
  types?: ColumnType[];
  /** Rôle obligatoire pour que le visuel s'affiche. */
  required?: boolean;
}

export interface OptionDef {
  key: string;
  label: string;
  type: "boolean" | "select" | "number" | "text" | "textarea";
  choices?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  placeholder?: string;
  section?: string;
  /** Affiche l'option seulement si la condition est vraie. */
  when?: (options: VisualOptions) => boolean;
}

/** Sélection issue d'un clic (filtrage croisé) : filtre les autres visuels du même jeu de données. */
export interface Selection {
  visualId: string;
  datasetId: string;
  filters: Filter[];
  /** Identifiants des éléments sélectionnés (pour la mise en évidence dans le visuel source). */
  keys: string[];
}

export interface VisualActions {
  pages: Page[];
  pageId: string;
  reportName: string;
  goToPage: (pageId: string) => void;
  resetFilters: () => void;
  /** Applique un signet du rapport ; false s'il n'existe plus. */
  applyBookmark: (bookmarkId: string) => boolean;
  /** Filtres actifs sur la page (pages, segments, sélection) — utilisés par les boutons. */
  activeFilters: Filter[];
}

export interface VisualProps {
  visual: Visual;
  def: VisualDef;
  dataset: DatasetProfile | undefined;
  /** Résultat de `def.query` (undefined pour les visuels sans requête). */
  result: QueryResult | null;
  filters: Filter[];
  selection: Selection | null;
  onSelect: (selection: Selection | null) => void;
  setOptions: (patch: VisualOptions) => void;
  actions: VisualActions;
  editing: boolean;
}

export type VisualGroup = "Graphiques" | "Données" | "Cartes" | "Interactivité";

export interface VisualDef {
  type: VisualType;
  label: string;
  icon: LucideIcon;
  group: VisualGroup;
  roles: RoleDef[];
  size: { w: number; h: number };
  defaults: VisualOptions;
  options: OptionDef[];
  component: ComponentType<VisualProps>;
  /** Requête principale ; `null` = pas assez de champs. Absent = visuel sans données (bouton, texte). */
  query?: (visual: Visual, filters: Filter[]) => QueryRequest | null;
}

/** Valeur d'option typée avec repli sur la valeur par défaut du type de visuel. */
export function opt<T>(visual: Visual, def: VisualDef, key: string): T {
  return (visual.options[key] ?? def.defaults[key]) as T;
}

export type { Scalar };
