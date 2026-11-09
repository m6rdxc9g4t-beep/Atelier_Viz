/** Exemples de la suite (miroir de backend/app/services/exemples.py). */

import type { DatasetSummary } from "./dataset";

export type SuiteExampleApp = "convert" | "tab" | "viz" | "tresorerie" | "nexus" | "projets" | "wiki";

export interface ExempleEtape {
  app: SuiteExampleApp;
  titre: string;
  texte: string;
}

export interface ExempleHistoire {
  id: string;
  titre: string;
  sous_titre: string;
  secteur: string;
  resume: string;
  parcours: ExempleEtape[];
  /** Noms des jeux de données que l'histoire crée. */
  jeux: string[];
  alerte: string;
  /** Nom du rapport d'exemple de l'histoire. */
  rapport: string;
  charge: boolean;
}

export interface ExempleCharge {
  histoire: string;
  datasets: DatasetSummary[];
  operations_id: string;
  alerte_id: string;
  alerte_declenchee: boolean;
  rapport: string;
}
