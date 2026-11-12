import clsx from "clsx";

import type { Page } from "../../types/report";
import { navigatorTabMinCss } from "../fit";
import { opt, type VisualProps } from "../types";

/** Pages listées par le navigateur : les pages d'extraction (atteintes par clic droit) en sont exclues. */
export function navigablePages(pages: Page[]): Page[] {
  return pages.filter((p) => !p.drillthrough?.fields.length);
}

/**
 * Navigateur de pages (comme celui de Power BI) : un onglet par page du rapport, la page courante
 * mise en avant, un clic pour changer de page. Suit automatiquement l'ajout, le renommage et l'ordre des pages.
 */
export function NavigatorVisual(props: VisualProps) {
  const { visual, def, actions, editing } = props;
  const vertical = opt<string>(visual, def, "orientation") === "vertical";
  const style = opt<string>(visual, def, "look");
  const pages = navigablePages(actions.pages);

  return (
    <nav aria-label="Pages du rapport" className={clsx("flex h-full gap-1", vertical ? "flex-col" : "items-stretch")}>
      {pages.map((p) => {
        const current = p.id === actions.pageId;
        return (
          <button
            key={p.id}
            type="button"
            aria-current={current ? "page" : undefined}
            onClick={() => !current && actions.goToPage(p.id)}
            className={clsx(
              "truncate rounded-md px-3 text-sm transition-colors",
              // Horizontal : chaque onglet part de la largeur de son nom, puis se partage la place qui reste
              // (à égalité, un nom long était abrégé alors que ses voisins avaient de la marge). Quand la place
              // manque, il ne descend pas sous son nom ni sous une part égale (`--tab-min`) : les noms courts
              // restent entiers, seuls les longs sont abrégés.
              vertical ? "min-w-0 shrink-0 py-2 text-left" : "min-w-[var(--tab-min)] flex-auto text-center",
              editing && "pointer-events-auto",
              style === "underline"
                ? current
                  ? "font-semibold shadow-[inset_0_-2px_0_var(--accent)]"
                  : "text-[color:var(--muted)] hover:text-[color:var(--fg)]"
                : current
                  ? "bg-[var(--accent)] font-medium text-[color:var(--accent-fg)]"
                  : "border border-[color:var(--border)] bg-[var(--surface)] hover:bg-[var(--surface-2)]",
            )}
            style={vertical ? undefined : ({ "--tab-min": navigatorTabMinCss(p.name, pages.length) } as React.CSSProperties)}
            title={p.name}
          >
            {p.name}
          </button>
        );
      })}
    </nav>
  );
}
