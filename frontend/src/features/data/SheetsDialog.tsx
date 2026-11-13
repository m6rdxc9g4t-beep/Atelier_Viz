import { FileSpreadsheet, Loader2, TriangleAlert, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";

import { useModalFocus } from "../../hooks/useModalFocus";
import { type SheetChoice, defaultSelection, importLabel, importable, toggleSheet } from "../../lib/workbook";

interface SheetsDialogProps {
  /** Nom du classeur (ou de la source) dont viennent les feuilles. */
  filename: string;
  sheets: SheetChoice[];
  /** Import en cours : les boutons attendent. */
  importing: boolean;
  /** Erreur du dernier essai d'import, dite dans le dialogue. */
  error?: string | null;
  onImport: (sheets: string[]) => void;
  onClose: () => void;
}

/**
 * Choix des feuilles d'un classeur à importer : toutes les feuilles lisibles sont cochées, chacune devient un jeu
 * nommé « Classeur — Feuille ». Une feuille vide ou illisible est montrée avec sa raison, sans case à cocher.
 */
export function SheetsDialog({ filename, sheets, importing, error, onImport, onClose }: SheetsDialogProps) {
  const dialogRef = useModalFocus<HTMLDivElement>();
  const titleId = useId();
  const [selected, setSelected] = useState(() => defaultSelection(sheets));
  const usable = importable(sheets);
  const allChecked = selected.length === usable.length;

  useEffect(() => {
    // En capture, et sans laisser passer : ouvert par-dessus un autre dialogue (connexion à une source), Échap ne
    // ferme que celui-ci.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      if (!importing) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [importing, onClose]);

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && !importing && onClose()}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="atelier-pop flex max-h-[88vh] w-full max-w-xl flex-col rounded-xl border border-border bg-surface text-fg shadow-2xl">
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <FileSpreadsheet className="size-4 shrink-0 text-muted" aria-hidden />
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="truncate text-sm font-semibold">
              Feuilles à importer
            </h2>
            <p className="text-xs break-words text-muted">
              {filename} · {sheets.length} feuilles, un jeu de données par feuille
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={importing} aria-label="Fermer" className="grid size-7 place-items-center rounded text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50 pointer-coarse:size-10">
            <X className="size-4" aria-hidden />
          </button>
        </header>

        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2 text-xs text-muted">
          <span aria-live="polite">
            {selected.length} sur {usable.length} {usable.length > 1 ? "feuilles cochées" : "feuille cochée"}
          </span>
          {usable.length > 1 && (
            <button type="button" onClick={() => setSelected(allChecked ? [] : defaultSelection(sheets))} disabled={importing} className="rounded px-1.5 py-1 font-medium text-accent-ink hover:underline disabled:opacity-50 pointer-coarse:py-2.5">
              {allChecked ? "Tout décocher" : "Tout cocher"}
            </button>
          )}
        </div>

        <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto" aria-label="Feuilles du classeur">
          {sheets.map((s) => {
            const checked = selected.includes(s.name);
            return (
              <li key={s.name}>
                {s.error ? (
                  <div className="flex min-h-(--row-h) items-start gap-3 px-4 py-2.5">
                    <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm text-muted">{s.name}</p>
                      <p className="text-xs text-muted">Laissée de côté — {s.error}</p>
                    </div>
                  </div>
                ) : (
                  <label className="flex min-h-(--row-h) cursor-pointer items-start gap-3 px-4 py-2.5 hover:bg-surface-2">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={importing}
                      onChange={() => setSelected((cur) => toggleSheet(sheets, cur, s.name))}
                      className="mt-0.5 size-4 shrink-0 accent-[var(--accent)]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{s.name}</span>
                      {s.summary && (
                        <span className="block truncate text-xs text-muted" title={s.summary}>
                          {s.summary}
                        </span>
                      )}
                      <span className="block truncate text-xs text-faint">Jeu « {s.dataset_name} »</span>
                    </span>
                  </label>
                )}
              </li>
            );
          })}
        </ul>

        {error && (
          <p role="alert" className="border-t border-line px-4 py-2 text-xs text-negative">
            {error}
          </p>
        )}
        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3">
          <button type="button" onClick={onClose} disabled={importing} className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-2 disabled:opacity-50 pointer-coarse:py-2.5">
            Annuler
          </button>
          <button
            type="button"
            onClick={() => onImport(selected)}
            disabled={importing || selected.length === 0}
            className="atelier-btn-primary flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-50 pointer-coarse:py-2.5"
          >
            {importing && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            {importLabel(selected.length)}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
