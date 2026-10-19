import { createContext, useContext } from "react";

import type { DatasetProfile, DatasetSummary } from "../types/dataset";

export interface StudioData {
  datasets: DatasetSummary[];
  profiles: Map<string, DatasetProfile>;
  /** Jeu de données courant du volet Données (nouveaux visuels). */
  activeDatasetId: string | null;
  setActiveDatasetId: (id: string) => void;
}

export const StudioDataContext = createContext<StudioData>({
  datasets: [],
  profiles: new Map(),
  activeDatasetId: null,
  setActiveDatasetId: () => {},
});

export const useStudioData = () => useContext(StudioDataContext);

export const FIELD_MIME = "application/x-atelier-field";

export interface DraggedField {
  datasetId: string;
  field: string;
}
