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

/** Navigation principale ; icônes seules dans le Studio et sous 1024px. */
export function Sidebar({ route, compact }: { route: Route; compact: boolean }) {
  return (
    <aside className={clsx("flex shrink-0 flex-col border-r border-border bg-surface", compact ? "w-12" : "w-12 lg:w-52")}>
      <div className={clsx("flex h-12 items-center border-b border-border px-2", !compact && "lg:px-3")}>
        <AtelierBrand showName={!compact} nameClassName="hidden lg:inline" />
      </div>
      <nav className="flex flex-col gap-1 p-1.5" aria-label="Navigation principale">
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
                "flex h-9 items-center gap-3 rounded-md px-2.5 text-sm transition-colors",
                current ? "bg-surface-2 font-medium text-fg" : "text-muted hover:bg-surface-2 hover:text-fg",
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              {!compact && <span className="hidden lg:inline">{label}</span>}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}
