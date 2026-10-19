import clsx from "clsx";
import { useEffect, useState } from "react";

import { api } from "../../lib/api";
import { formatCount, formatValue } from "../../lib/format";
import type { ColumnProfile, Row } from "../../types/dataset";

const PAGE = 100;

interface DataPreviewProps {
  datasetId: string;
  columns: ColumnProfile[];
  total: number;
}

/** Aperçu tabulaire paginé (100 lignes par chargement). */
export function DataPreview({ datasetId, columns, total }: DataPreviewProps) {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = (offset: number) => {
    setLoading(true);
    api.datasets
      .rows(datasetId, offset, PAGE)
      .then((page) => setRows((prev) => (offset === 0 ? page.rows : [...prev, ...page.rows])))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    setRows([]);
    setError(null);
    load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- recharger uniquement au changement de jeu
  }, [datasetId]);

  return (
    <section aria-labelledby="preview-title" className="flex min-h-0 flex-1 flex-col rounded-lg border border-border bg-surface">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 id="preview-title" className="text-sm font-medium">
          Aperçu
        </h2>
        <span className="text-xs text-muted">
          {formatCount(rows.length)} / {formatCount(total)} lignes
        </span>
      </header>
      {error && <p className="px-4 py-3 text-sm text-negative">{error}</p>}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead className="sticky top-0 z-10 bg-surface">
            <tr>
              {columns.map((c) => (
                <th
                  key={c.name}
                  scope="col"
                  className={clsx(
                    "whitespace-nowrap border-b border-border px-3 py-2 text-xs font-medium text-muted",
                    c.type === "number" ? "text-right" : "text-left",
                  )}
                >
                  {c.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className="hover:bg-surface-2">
                {columns.map((c) => {
                  const value = row[c.name] ?? null;
                  return (
                    <td
                      key={c.name}
                      className={clsx(
                        "whitespace-nowrap border-b border-border/60 px-3 py-1.5",
                        c.type === "number" && "text-right tabular-nums",
                        value === null && "text-muted",
                      )}
                    >
                      {formatValue(value, c.type)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length < total && (
        <footer className="border-t border-border px-4 py-2">
          <button
            type="button"
            onClick={() => load(rows.length)}
            disabled={loading}
            className="text-xs font-medium text-accent hover:underline disabled:opacity-50"
          >
            {loading ? "Chargement…" : `Afficher ${Math.min(PAGE, total - rows.length)} lignes de plus`}
          </button>
        </footer>
      )}
    </section>
  );
}
