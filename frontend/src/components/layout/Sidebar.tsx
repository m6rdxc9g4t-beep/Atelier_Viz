import clsx from "clsx";
import { Database, LayoutDashboard, type LucideIcon, Settings, Workflow } from "lucide-react";

import type { Route } from "../../lib/router";
import { navigate } from "../../lib/router";
import { AtelierBrand } from "./AtelierBrand";

interface NavItem {
  label: string;
  icon: LucideIcon;
  path: string;
  match: Route["name"][];
}

const NAV: NavItem[] = [
  { label: "Rapports", icon: LayoutDashboard, path: "/", match: ["reports", "studio"] },
  { label: "Données", icon: Database, path: "/donnees", match: ["data"] },
  { label: "Automatisation", icon: Workflow, path: "/automatisation", match: ["automation"] },
  { label: "Réglages", icon: Settings, path: "/reglages", match: ["settings"] },
];

/**
 * Navigation principale, à la forme du portail (docs/SUITE.md §1.7) : barre latérale neutre de 232 px, marque en haut,
 * entrées de 30 px, entrée courante sur fond neutre. Icônes seules dans le Studio et sous 1024 px.
 */
export function Sidebar({ route, compact }: { route: Route; compact: boolean }) {
  return (
    <aside className={clsx("flex shrink-0 flex-col border-r border-line bg-sidebar", compact ? "w-12" : "w-12 lg:w-(--side-w)")}>
      <div className={clsx("flex h-(--top-h) shrink-0 items-center justify-center", !compact && "lg:justify-start lg:px-3")}>
        <AtelierBrand showName={!compact} nameClassName="hidden lg:inline" />
      </div>
      <nav className={clsx("flex flex-col gap-px px-2 pt-1", !compact && "lg:px-2")} aria-label="Navigation principale">
        {NAV.map(({ label, icon: Icon, path, match }) => {
          const current = match.includes(route.name);
          return (
            <button
              key={label}
              type="button"
              title={label}
              onClick={() => navigate(path)}
              aria-current={current ? "page" : undefined}
              className={clsx(
                "flex h-[30px] items-center justify-center gap-2.5 rounded-md px-2 text-sm font-medium transition-colors duration-100",
                !compact && "lg:justify-start",
                current ? "atelier-nav-active [&>svg]:text-fg" : "text-fg/80 hover:bg-surface-2 hover:text-fg [&>svg]:text-faint",
              )}
            >
              <Icon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
              {!compact && <span className="hidden lg:inline">{label}</span>}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
