import clsx from "clsx";
import { BarChart3, CalendarCheck, Check, LayoutGrid, type LucideIcon, Table2 } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";

import { openExternal } from "../../lib/desktop";
import { CURRENT_APP, type SuiteAppId, type SuiteStatus, checkAnyHealth, statusLabel, suiteApps } from "../../lib/suite";

/** Icônes de la marque commune (docs/SUITE.md §1.6). */
const ICONS: Record<SuiteAppId, LucideIcon> = { viz: BarChart3, tab: Table2, projets: CalendarCheck };

/**
 * Sélecteur « Suite Atelier » (docs/SUITE.md §3) : les trois applications, la courante cochée,
 * un état « en marche / arrêtée » pour les trois (vérifié à l'ouverture, sans bloquer le menu) :
 * Viz sur sa propre origine, Tab sur 4175 puis 5175, Projets sur son API.
 * Clavier : flèches, Début / Fin, Entrée ; Échap, Tab ou un clic à l'extérieur ferment le menu.
 */
export function SuiteSwitcher() {
  const apps = useMemo(() => suiteApps(), []);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<Partial<Record<SuiteAppId, SuiteStatus>>>({});
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  }, []);

  // À l'ouverture : focus sur l'application courante, puis vérification des API en parallèle.
  useEffect(() => {
    if (!open) return;
    items.current[Math.max(0, apps.findIndex((a) => a.id === CURRENT_APP))]?.focus();
    let alive = true;
    for (const app of apps) {
      if (app.id === CURRENT_APP || !app.healthUrls.length) continue; // la page tourne : « en marche »
      setStatus((s) => ({ ...s, [app.id]: "unknown" }));
      void checkAnyHealth(app.healthUrls).then((st) => {
        if (alive) setStatus((s) => ({ ...s, [app.id]: st }));
      });
    }
    return () => {
      alive = false;
    };
  }, [open, apps]);

  // Clic à l'extérieur : fermeture sans reprendre le focus (l'utilisateur clique ailleurs).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, close]);

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = items.current.filter((x): x is HTMLButtonElement => !!x);
    const index = list.indexOf(document.activeElement as HTMLButtonElement);
    const move = (i: number) => list[(i + list.length) % list.length]?.focus();
    if (e.key === "ArrowDown") move(index + 1);
    else if (e.key === "ArrowUp") move(index - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(list.length - 1);
    else if (e.key === "Escape") close(true);
    else if (e.key === "Tab") return close(false);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div ref={root} className="relative">
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label="Suite Atelier"
        title="Suite Atelier"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={clsx("rounded-md p-1.5 hover:bg-surface-2 hover:text-fg", open ? "bg-surface-2 text-fg" : "text-muted")}
      >
        <LayoutGrid className="size-4" aria-hidden />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Suite Atelier"
          onKeyDown={onMenuKey}
          className="absolute top-full left-0 z-50 mt-1.5 w-72 rounded-lg border border-border bg-surface p-1.5 text-fg shadow-xl"
        >
          <p className="px-2 pt-1 pb-1.5 text-[10px] font-medium tracking-wide text-muted uppercase" aria-hidden>
            Suite Atelier
          </p>
          {apps.map((app, i) => {
            const Icon = ICONS[app.id];
            const current = app.id === CURRENT_APP;
            // L'application courante est toujours « en marche » (docs/SUITE.md §3) : la page tourne.
            const st = current ? "up" : app.healthUrls.length ? (status[app.id] ?? "unknown") : null;
            return (
              <button
                key={app.id}
                ref={(el) => {
                  items.current[i] = el;
                }}
                type="button"
                role="menuitemradio"
                aria-checked={current}
                aria-label={`${app.name}${st ? ` (${statusLabel(st)})` : ""}`}
                title={app.url}
                tabIndex={-1}
                onClick={() => {
                  close(true);
                  if (!current) openExternal(app.url);
                }}
                className={clsx(
                  "flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left outline-none hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent",
                  current && "bg-accent/10",
                )}
              >
                <span className="atelier-brand__tile atelier-brand__tile--sm" aria-hidden>
                  <Icon />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="atelier-brand__name atelier-brand__name--sm">
                      <span className="atelier-brand__prefix">atelier_</span>
                      {app.short}
                    </span>
                    {st && <StatusDot status={st} />}
                  </span>
                  <span className="block truncate text-xs text-muted">{app.description}</span>
                </span>
                {current && <Check className="size-4 shrink-0 text-accent" aria-hidden />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Pastille d'état + libellé court (la couleur n'est jamais seule porteuse de sens). */
function StatusDot({ status }: { status: SuiteStatus }) {
  return (
    <span className="flex items-center gap-1 text-[11px] font-normal text-muted" aria-hidden>
      <span className={clsx("size-1.5 rounded-full", status === "up" ? "bg-positive" : status === "down" ? "bg-negative" : "animate-pulse bg-muted/60")} />
      {statusLabel(status)}
    </span>
  );
}
