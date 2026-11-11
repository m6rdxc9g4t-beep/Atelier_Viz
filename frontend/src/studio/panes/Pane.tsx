import clsx from "clsx";
import { ChevronsLeft, ChevronsRight } from "lucide-react";
import { type ReactNode, useState } from "react";

import { isNarrowScreen } from "../../lib/viewport";

/**
 * Volet latéral repliable (comme les volets Filtres / Visualisations / Données de Power BI).
 * Sur un écran étroit (téléphone), les volets d'édition (`compactOnNarrow`) s'ouvrent repliés et tout volet ouvert
 * se pose par-dessus la page au lieu de la pousser hors de l'écran.
 */
export function Pane({ title, width, children, defaultOpen = true, compactOnNarrow = false }: { title: string; width: string; children: ReactNode; defaultOpen?: boolean; compactOnNarrow?: boolean }) {
  const [open, setOpen] = useState(() => defaultOpen && !(compactOnNarrow && isNarrowScreen()));
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-8 shrink-0 flex-col items-center gap-2 border-l border-line bg-surface py-3 text-xs text-muted hover:text-fg"
        aria-label={`Ouvrir le volet ${title}`}
      >
        <ChevronsLeft className="size-3.5" aria-hidden />
        <span className="[writing-mode:vertical-rl]">{title}</span>
      </button>
    );
  }
  return (
    <aside className={clsx("flex shrink-0 flex-col border-l border-line bg-surface max-md:absolute max-md:inset-y-0 max-md:right-0 max-md:z-20 max-md:max-w-full", width)} aria-label={title}>
      <header className="flex h-10 shrink-0 items-center justify-between border-b border-line px-3">
        <h2 className="text-sm font-semibold text-fg">{title}</h2>
        <button type="button" onClick={() => setOpen(false)} aria-label={`Replier le volet ${title}`} className="grid size-6 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-fg">
          <ChevronsRight className="size-3.5" aria-hidden />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
    </aside>
  );
}

export function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="border-b border-line px-3 py-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-medium text-fg/80">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}
