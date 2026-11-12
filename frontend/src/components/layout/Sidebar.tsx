import clsx from "clsx";
import { BookOpen, Database, LayoutDashboard, type LucideIcon, Settings, Workflow } from "lucide-react";
import { useState } from "react";

import { SuiteExamplesDialog } from "../../features/reports/SuiteExamplesDialog";

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

const EXAMPLES_LABEL = "Exemples de la suite";

/**
 * Navigation principale, à la forme du portail (docs/SUITE.md §1.7) : barre latérale neutre de 232 px, marque en haut,
 * entrées de 30 px (40 px au doigt), entrée courante sur fond neutre. Icônes seules dans le Studio et sous 1024 px.
 * Au pied : « Exemples de la suite » (comme dans Atelier Tab), qui ouvre son dialogue depuis n'importe quel écran.
 */
export function Sidebar({ route, compact }: { route: Route; compact: boolean }) {
  const [examplesOpen, setExamplesOpen] = useState(false);
  return (
    <aside className={clsx("flex shrink-0 flex-col border-r border-line bg-sidebar", compact ? "w-12" : "w-12 lg:w-(--side-w)")}>
      <div className={clsx("flex h-(--top-h) shrink-0 items-center justify-center", !compact && "lg:justify-start lg:px-3")}>
        <AtelierBrand showName={!compact} nameClassName="hidden lg:inline" />
      </div>
      <nav className={clsx("flex flex-col gap-px px-2 pt-1 pointer-coarse:px-1", !compact && "lg:px-2")} aria-label="Navigation principale">
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
                "flex h-[30px] items-center justify-center gap-2.5 rounded-md px-2 text-sm font-medium transition-colors duration-100 pointer-coarse:h-10",
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
      <div className={clsx("mt-auto flex flex-col px-2 pb-2 pointer-coarse:px-1", !compact && "lg:px-2")}>
        <button
          type="button"
          // Rail d'icônes : le nom reste lisible par l'info-bulle et les lecteurs d'écran.
          title={EXAMPLES_LABEL}
          aria-label={EXAMPLES_LABEL}
          aria-haspopup="dialog"
          onClick={() => setExamplesOpen(true)}
          className={clsx(
            "flex h-[30px] items-center justify-center gap-2.5 rounded-md px-2 text-sm text-muted transition-colors duration-100 hover:bg-surface-2 hover:text-fg pointer-coarse:h-10 [&>svg]:text-faint",
            !compact && "lg:justify-start",
          )}
        >
          <BookOpen className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
          {!compact && <span className="hidden truncate lg:inline">{EXAMPLES_LABEL}</span>}
        </button>
      </div>
      {examplesOpen && <SuiteExamplesDialog onClose={() => setExamplesOpen(false)} />}
    </aside>
  );
}
