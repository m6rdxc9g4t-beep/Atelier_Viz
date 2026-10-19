import clsx from "clsx";
import { ArrowDown, ArrowUp, Bookmark as BookmarkIcon, BookmarkPlus, Check, MoreHorizontal, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";

import type { Bookmark } from "../../types/report";
import { describeBookmark } from "../bookmarks";
import { useStudio } from "../store";
import { Pane } from "./Pane";

/**
 * Volet Signets (comme Power BI) : capturer l'état du rapport (page, filtres, segments, sélection,
 * exploration), l'appliquer d'un clic, le mettre à jour, le renommer, le supprimer, le réordonner.
 */
export function BookmarksPane() {
  const report = useStudio((s) => s.report);
  const mode = useStudio((s) => s.mode);
  const [active, setActive] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const s = useStudio.getState;
  if (!report) return null;
  const bookmarks = report.bookmarks ?? [];
  const editing = mode === "edit";

  const add = () => {
    const id = s().addBookmark();
    if (id) {
      setActive(id);
      setRenaming(id);
    }
  };

  return (
    <Pane title="Signets" width="w-64">
      <div className="space-y-2 border-b border-border p-3">
        <button
          type="button"
          onClick={add}
          className="flex w-full items-center justify-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg hover:brightness-110"
        >
          <BookmarkPlus className="size-3.5" aria-hidden /> Ajouter un signet
        </button>
        <p className="text-[11px] leading-snug text-muted">
          Un signet retient la page affichée, ses filtres, la sélection des segments, le filtrage croisé et le niveau d'exploration. Cliquez un signet pour l'appliquer.
        </p>
      </div>

      {bookmarks.length === 0 ? (
        <p className="p-4 text-center text-xs text-muted">Aucun signet pour l'instant.</p>
      ) : (
        <ol className="p-1.5" aria-label="Signets du rapport">
          {bookmarks.map((b, i) => (
            <li key={b.id} className="relative">
              {renaming === b.id ? (
                <RenameField
                  bookmark={b}
                  onDone={(name) => {
                    if (name !== null) s().renameBookmark(b.id, name);
                    setRenaming(null);
                  }}
                />
              ) : (
                <div
                  className={clsx(
                    "group flex items-start gap-2 rounded-md px-2 py-1.5",
                    active === b.id ? "bg-accent/10" : "hover:bg-surface-2",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (s().applyBookmark(b.id)) setActive(b.id);
                    }}
                    onDoubleClick={() => setRenaming(b.id)}
                    title="Appliquer ce signet (double-clic : renommer)"
                    className="flex min-w-0 flex-1 items-start gap-2 text-left"
                  >
                    <BookmarkIcon className={clsx("mt-0.5 size-3.5 shrink-0", active === b.id ? "fill-current text-accent" : "text-muted")} aria-hidden />
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium">{b.name}</span>
                      <span className="block truncate text-[11px] text-muted">{describeBookmark(report, b)}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    aria-label={`Options du signet ${b.name}`}
                    aria-expanded={menu === b.id}
                    onClick={() => setMenu((m) => (m === b.id ? null : b.id))}
                    className={clsx("rounded p-0.5 text-muted hover:bg-surface hover:text-fg", menu === b.id ? "opacity-100" : "opacity-60 group-hover:opacity-100")}
                  >
                    <MoreHorizontal className="size-3.5" aria-hidden />
                  </button>
                </div>
              )}
              {menu === b.id && (
                <div role="menu" aria-label={`Options du signet ${b.name}`} className="mx-2 mb-1.5 space-y-1 rounded-md border border-border bg-bg p-1.5 text-xs">
                  <MenuItem
                    icon={RefreshCw}
                    label="Mettre à jour avec l'état actuel"
                    onClick={() => {
                      s().updateBookmark(b.id);
                      s().notify(`Signet « ${b.name} » mis à jour.`);
                      setMenu(null);
                    }}
                  />
                  <MenuItem
                    icon={Pencil}
                    label="Renommer"
                    onClick={() => {
                      setRenaming(b.id);
                      setMenu(null);
                    }}
                  />
                  <div className="flex gap-1">
                    <MenuItem icon={ArrowUp} label="Monter" disabled={i === 0} onClick={() => s().moveBookmark(b.id, -1)} />
                    <MenuItem icon={ArrowDown} label="Descendre" disabled={i === bookmarks.length - 1} onClick={() => s().moveBookmark(b.id, 1)} />
                  </div>
                  <fieldset className="space-y-1 border-t border-border px-1.5 pt-1.5">
                    <legend className="sr-only">Ce que le signet applique</legend>
                    <Toggle label="Page affichée" checked={b.apply_page} onChange={(v) => s().setBookmarkFlags(b.id, { apply_page: v })} />
                    <Toggle label="Données (filtres, segments, exploration)" checked={b.apply_data} onChange={(v) => s().setBookmarkFlags(b.id, { apply_data: v })} />
                  </fieldset>
                  {confirmDelete === b.id ? (
                    <div className="flex items-center gap-2 border-t border-border px-1.5 pt-1.5">
                      <span className="flex-1 text-muted">Supprimer ?</span>
                      <button
                        type="button"
                        className="font-medium text-negative hover:underline"
                        onClick={() => {
                          s().removeBookmark(b.id);
                          setConfirmDelete(null);
                          setMenu(null);
                          if (active === b.id) setActive(null);
                        }}
                      >
                        Supprimer
                      </button>
                      <button type="button" className="text-muted hover:underline" onClick={() => setConfirmDelete(null)}>
                        Annuler
                      </button>
                    </div>
                  ) : (
                    <MenuItem icon={Trash2} label="Supprimer" danger onClick={() => setConfirmDelete(b.id)} />
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {editing && bookmarks.length > 0 && (
        <p className="px-3 pb-3 text-[11px] text-muted">
          Astuce : un « Bouton d'action » peut appliquer un signet (action « Appliquer un signet »).
        </p>
      )}
    </Pane>
  );
}

function RenameField({ bookmark, onDone }: { bookmark: Bookmark; onDone: (name: string | null) => void }) {
  const [value, setValue] = useState(bookmark.name);
  return (
    <form
      className="flex items-center gap-1 px-1.5 py-1"
      onSubmit={(e) => {
        e.preventDefault();
        onDone(value);
      }}
    >
      <input
        autoFocus
        aria-label="Nom du signet"
        value={value}
        maxLength={80}
        onChange={(e) => setValue(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => onDone(value)}
        onKeyDown={(e) => e.key === "Escape" && onDone(null)}
        className="min-w-0 flex-1 rounded border border-accent bg-bg px-2 py-1 text-xs"
      />
      <button type="submit" aria-label="Valider le nom" className="rounded p-1 text-accent hover:bg-surface-2">
        <Check className="size-3.5" aria-hidden />
      </button>
    </form>
  );
}

function MenuItem({ icon: Icon, label, onClick, disabled, danger }: { icon: typeof Pencil; label: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        "flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-surface-2 disabled:opacity-30 disabled:hover:bg-transparent",
        danger ? "text-negative" : "text-fg",
      )}
    >
      <Icon className="size-3.5 shrink-0" aria-hidden /> {label}
    </button>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[11px] text-muted">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-[var(--accent)]" />
      {label}
    </label>
  );
}
