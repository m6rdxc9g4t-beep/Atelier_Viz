import clsx from "clsx";
import { ChevronsLeft, ChevronsRight } from "lucide-react";
import { type ReactNode, useState } from "react";

/** Volet latéral repliable (comme les volets Filtres / Visualisations / Données de Power BI). */
export function Pane({ title, width, children, defaultOpen = true }: { title: string; width: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-8 shrink-0 flex-col items-center gap-2 border-l border-border bg-surface py-3 text-xs text-muted hover:text-fg"
        aria-label={`Ouvrir le volet ${title}`}
      >
        <ChevronsLeft className="size-3.5" aria-hidden />
        <span className="[writing-mode:vertical-rl]">{title}</span>
      </button>
    );
  }
  return (
    <aside className={clsx("atelier-glass flex shrink-0 flex-col border-l border-border bg-surface", width)} aria-label={title}>
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</h2>
        <button type="button" onClick={() => setOpen(false)} aria-label={`Replier le volet ${title}`} className="rounded p-1 text-muted hover:bg-surface-2 hover:text-fg">
          <ChevronsRight className="size-3.5" aria-hidden />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </aside>
  );
}

export function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="border-b border-border px-3 py-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[11px] font-semibold text-muted">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}
