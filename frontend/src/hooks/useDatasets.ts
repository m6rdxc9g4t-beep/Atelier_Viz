import { useCallback, useEffect, useState } from "react";

import { api } from "../lib/api";
import { invalidateQueries } from "../visuals/useQueryResult";
import { forgetProfile } from "./useDatasetProfiles";
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
        invalidateQueries(id);
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

  return {
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
