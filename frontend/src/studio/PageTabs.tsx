import clsx from "clsx";
import { Copy, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { useStudio } from "./store";

/** Onglets de pages (bas de l'écran, comme Power BI) : double-clic pour renommer. */
export function PageTabs() {
  const report = useStudio((s) => s.report);
  const pageId = useStudio((s) => s.pageId);
  const mode = useStudio((s) => s.mode);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const s = useStudio.getState;
  if (!report) return null;
  const editing = mode === "edit";

  return (
    <nav className="flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-t border-border bg-surface px-2" aria-label="Pages du rapport">
      {report.pages.map((p) =>
        renaming === p.id ? (
          <input
            key={p.id}
            autoFocus
            defaultValue={p.name}
            aria-label="Nom de la page"
            onBlur={(e) => {
              s().renamePage(p.id, e.target.value);
              setRenaming(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setRenaming(null);
            }}
            className="w-32 rounded border border-accent bg-bg px-2 py-1 text-xs"
          />
        ) : (
          <div key={p.id} className="group flex shrink-0 items-center">
            <button
              type="button"
              aria-current={p.id === pageId ? "page" : undefined}
              onClick={() => s().setPage(p.id)}
              onDoubleClick={() => editing && setRenaming(p.id)}
              title={editing ? "Double-cliquez pour renommer" : p.name}
              className={clsx(
                "rounded-md px-3 py-1.5 text-xs",
                p.id === pageId ? "bg-surface-2 font-medium text-fg" : "text-muted hover:bg-surface-2 hover:text-fg",
              )}
            >
              {p.name}
            </button>
            {editing && p.id === pageId && (
              <span className="flex items-center">
                <button type="button" onClick={() => s().duplicatePage(p.id)} aria-label="Dupliquer la page" className="rounded p-1 text-muted hover:text-fg">
                  <Copy className="size-3" aria-hidden />
                </button>
                {report.pages.length > 1 &&
                  (confirmDelete === p.id ? (
                    <button
                      type="button"
                      onClick={() => {
                        s().removePage(p.id);
                        setConfirmDelete(null);
                      }}
                      onBlur={() => setConfirmDelete(null)}
                      className="rounded px-1.5 py-0.5 text-[11px] font-medium text-negative hover:bg-negative/10"
                    >
                      Supprimer ?
                    </button>
                  ) : (
                    <button type="button" onClick={() => setConfirmDelete(p.id)} aria-label="Supprimer la page" className="rounded p-1 text-muted hover:text-negative">
                      <Trash2 className="size-3" aria-hidden />
                    </button>
                  ))}
              </span>
            )}
          </div>
        ),
      )}
      {editing && (
        <button type="button" onClick={() => s().addPage()} aria-label="Ajouter une page" className="ml-1 rounded-md p-1.5 text-muted hover:bg-surface-2 hover:text-fg">
          <Plus className="size-3.5" aria-hidden />
        </button>
      )}
    </nav>
  );
}
