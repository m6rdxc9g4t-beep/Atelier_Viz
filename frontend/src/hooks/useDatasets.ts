import { useCallback, useEffect, useState } from "react";

import { api } from "../lib/api";
import { datasetChanged, forgetProfile, refreshDataset } from "./useDatasetProfiles";
import { onDatasetRefreshed } from "./useDataVersions";
import type { DatasetProfile, DatasetSummary } from "../types/dataset";

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
  clearError: () => void;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Liste des jeux de données importés + profil du jeu sélectionné. */
export function useDatasets(): DatasetsState {
  const [datasets, setDatasets] = useState<DatasetSummary[]>([]);
  const [selected, setSelected] = useState<DatasetProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);

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

  return {
    added,
    refresh,
    refreshing,
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
