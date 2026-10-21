/** Rendu « instantané » d'une page (export image / PDF / HTML) : lecture seule, état figé. */

import { createContext, useContext } from "react";

import type { Selection } from "../visuals/types";
import type { Extraction } from "./extraction";

export interface Snapshot {
  /** Sélection (filtrage croisé) à appliquer à cette page, ou null. */
  selection: Selection | null;
  extraction: Extraction | null;
}

/** Présent = la page est rendue pour un export : pas d'édition, sélection et extraction données. */
export const SnapshotContext = createContext<Snapshot | null>(null);

export const useSnapshot = () => useContext(SnapshotContext);
