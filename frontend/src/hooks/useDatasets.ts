import { useCallback, useEffect, useState } from "react";

import { api, ApiError } from "../lib/api";
import { datasetChanged, forgetProfile, refreshDataset, replaceDatasetData } from "./useDatasetProfiles";
import { onDatasetRefreshed } from "./useDataVersions";
import type { DatasetProfile, DatasetSummary, ModelIssue } from "../types/dataset";

export interface DatasetsState {
  datasets: DatasetSummary[];
  selected: DatasetProfile | null;
  loading: boolean;
  uploading: boolean;
  error: string | null;
  select: (id: string) => void;
  upload: (file: File) => Promise<void>;
  /** Importe les jeux d'exemple du dépôt (samples/). */
  loadSamples: () => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** Ajoute un jeu importé depuis une connexion et le sélectionne. */
  added: (profile: DatasetProfile) => void;
  /** Relit la source d'un jeu issu d'une connexion. */
  refresh: (id: string) => Promise<void>;
  /** Identifiant du jeu en cours d'actualisation. */
  refreshing: string | null;
  /**
   * Remplace les données d'un jeu importé par fichier (même jeu : rapports, modèle et alertes suivent).
   * Si le fichier n'a plus certaines colonnes du jeu, rien n'est remplacé : `pendingReplace` attend la
   * confirmation, donnée en rappelant avec `force`.
   */
  replaceData: (id: string, file: File, force?: boolean) => Promise<void>;
  /** Remplacement en attente de confirmation : le fichier choisi perdrait des colonnes du jeu. */
  pendingReplace: PendingReplace | null;
  /** Renonce au remplacement en attente (rien n'a changé). */
  cancelReplace: () => void;
  /** Identifiant du jeu dont les données sont en cours de remplacement. */
  replacing: string | null;
  /** Augmente à chaque remplacement de données réussi : l'aperçu se recharge même à nombre de lignes égal. */
  revision: number;
  clearError: () => void;
}

/** Fichier de remplacement auquel il manque des colonnes du jeu : à confirmer avant de l'envoyer de nouveau. */
export interface PendingReplace {
  id: string;
  file: File;
  /** Colonnes du jeu absentes du fichier (visuels, filtres et alertes qui les lisent ne fonctionneraient plus). */
  missing: string[];
  /** Colonnes du fichier que le jeu n'a pas. */
  added: string[];
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

const names = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** Colonnes perdues annoncées par un refus de remplacement (409 `COLUMNS_LOST`), sinon `null` (autre erreur). */
export function lostColumns(err: unknown): Pick<PendingReplace, "missing" | "added"> | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const detail = err.detail;
  if (!detail || typeof detail !== "object" || !("code" in detail) || detail.code !== "COLUMNS_LOST") return null;
  const missing = names("missing" in detail ? detail.missing : undefined);
  return missing.length ? { missing, added: names("added" in detail ? detail.added : undefined) } : null;
}

/** Liste des jeux de données importés + profil du jeu sélectionné. */
export function useDatasets(): DatasetsState {
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [selected, setSelected] = useState<DatasetProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [replacing, setReplacing] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [pendingReplace, setPendingReplace] = useState<PendingReplace | null>(null);

  const select = useCallback((id: string) => {
    setLoading(true);
    api.datasets
      .get(id)
      .then(setSelected)
      .catch((err: unknown) => setError(message(err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    api.datasets
      .list()
      .then((list) => {
        setDatasets(list);
        const first = list[0];
        if (first) select(first.id);
        else setLoading(false);
      })
      .catch((err: unknown) => {
        setError(message(err));
        setLoading(false);
      });
  }, [select]);

  // Actualisation planifiée en arrière-plan : la liste et le jeu affiché suivent.
  useEffect(
    () =>
      onDatasetRefreshed((profile) => {
        setDatasets((list) => list.map((d) => (d.id === profile.id ? profile : d)));
        setSelected((cur) => (cur?.id === profile.id ? profile : cur));
      }),
    [],
  );

  const upload = useCallback(async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const profile = await api.datasets.upload(file);
      setDatasets((list) => [profile, ...list]);
      setSelected(profile);
    } catch (err) {
      setError(`${file.name} : ${message(err)}`);
    } finally {
      setUploading(false);
    }
  }, []);

  const loadSamples = useCallback(async () => {
    setUploading(true);
    setError(null);
    try {
      const res = await api.samples.load();
      setDatasets(await api.datasets.list());
      const first = res.datasets.find((d) => d.name === "ventes_2026.csv") ?? res.datasets[0];
      if (first) select(first.id);
      else setError("Aucun fichier d'exemple trouvé dans le dossier samples/ du dépôt.");
    } catch (err) {
      setError(message(err));
    } finally {
      setUploading(false);
    }
  }, [select]);

  const remove = useCallback(
    async (id: string) => {
      try {
        await api.datasets.remove(id);
        forgetProfile(id);
        datasetChanged(id);
        const rest = datasets.filter((d) => d.id !== id);
        setDatasets(rest);
        if (selected?.id === id) {
          setSelected(null);
          const next = rest[0];
          if (next) select(next.id);
        }
      } catch (err) {
        setError(message(err));
      }
    },
    [datasets, selected, select],
  );

  const added = useCallback((profile: DatasetProfile) => {
    setDatasets((list) => [profile, ...list.filter((d) => d.id !== profile.id)]);
    setSelected(profile);
    setError(null);
  }, []);

  const refresh = useCallback(async (id: string) => {
    setRefreshing(id);
    setError(null);
    try {
      const profile = await refreshDataset(id);
      setDatasets((list) => list.map((d) => (d.id === id ? profile : d)));
      setSelected((cur) => (cur?.id === id ? profile : cur));
    } catch (err) {
      setError(`Actualisation impossible : ${message(err)}`);
    } finally {
      setRefreshing(null);
    }
  }, []);

  const replaceData = useCallback(async (id: string, file: File, force = false) => {
    setReplacing(id);
    setError(null);
    setPendingReplace(null);
    try {
      const profile = await replaceDatasetData(id, file, force);
      setDatasets((list) => list.map((d) => (d.id === id ? profile : d)));
      setSelected((cur) => (cur?.id === id ? profile : cur));
      setRevision((n) => n + 1);
    } catch (err) {
      // Colonnes du jeu absentes du fichier (mauvais fichier ?) : rien n'a changé, la confirmation est demandée.
      const lost = lostColumns(err);
      if (lost) {
        setPendingReplace({ id, file, ...lost });
        return;
      }
      // Modèle qui ne tient plus (colonne disparue) : le détail dit quelle colonne ou mesure est en cause.
      const issues = (err as { detail?: { issues?: ModelIssue[] } }).detail?.issues;
      const detail = issues?.map((i) => `${i.name} : ${i.error}`).join(" ; ");
      setError(`${file.name} : ${message(err)}${detail ? ` ${detail}` : ""}`);
    } finally {
      setReplacing(null);
    }
  }, []);

  return {
    added,
    refresh,
    refreshing,
    replaceData,
    replacing,
    pendingReplace,
    cancelReplace: () => setPendingReplace(null),
    revision,
    datasets,
    selected,
    loading,
    uploading,
    error,
    select,
    upload,
    loadSamples,
    remove,
    clearError: () => setError(null),
  };
}
