import clsx from "clsx";
import { Bell, BellRing } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { onDatasetRefreshed } from "../../hooks/useDataVersions";
import { api } from "../../lib/api";
import { navigate } from "../../lib/router";
import type { AlertNotification } from "../../types/alert";
import { whenLabel } from "./schedule";

const POLL_MS = 30_000;

/** Cloche des notifications d'alertes (en-tête) : pastille des non lues, liste, « Tout marquer comme lu ». */
export function NotificationBell() {
  const [notes, setNotes] = useState<AlertNotification[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    api.alerts
      .notifications()
      .then(setNotes)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(() => document.visibilityState !== "hidden" && load(), POLL_MS);
    const off = onDatasetRefreshed(load);
    return () => {
      clearInterval(timer);
      off();
    };
  }, [load]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const unread = notes.filter((n) => !n.read).length;
  const Icon = unread ? BellRing : Bell;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o);
          if (!open) load();
        }}
        aria-expanded={open}
        aria-label={unread ? `Notifications : ${unread} non lue${unread > 1 ? "s" : ""}` : "Notifications"}
        title="Notifications des alertes"
        className={clsx("relative rounded-md p-2 hover:bg-surface-2 hover:text-fg", unread ? "text-fg" : "text-muted")}
      >
        <Icon className="size-4" aria-hidden />
        {unread > 0 && (
          <span className="absolute top-1 right-1 flex min-w-4 items-center justify-center rounded-full bg-negative px-1 text-[9px] leading-4 font-semibold text-white tabular-nums">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div role="dialog" aria-label="Notifications" className="atelier-pop absolute top-full right-0 z-50 mt-1 w-80 overflow-hidden rounded-lg border border-border bg-surface shadow-xl">
          <header className="flex items-center justify-between border-b border-border px-3 py-2">
            <h2 className="text-xs font-semibold">Alertes déclenchées</h2>
            {unread > 0 && (
              <button
                type="button"
                onClick={() =>
                  void api.alerts
                    .markRead()
                    .then(setNotes)
                    .catch(() => undefined)
                }
                className="text-[11px] text-accent-ink hover:underline"
              >
                Tout marquer comme lu
              </button>
            )}
          </header>
          {notes.length === 0 ? (
            <p className="px-3 py-4 text-center text-xs text-muted">Aucune notification.</p>
          ) : (
            <ul className="max-h-80 overflow-y-auto">
              {notes.slice(0, 30).map((n) => (
                <li key={n.id} className={clsx("border-b border-border/60 px-3 py-2 last:border-0", !n.read && "bg-accent/5")}>
                  <p className="flex items-start gap-1.5 text-xs">
                    {!n.read && <span className="mt-1 size-1.5 shrink-0 rounded-full bg-negative" aria-label="Non lue" />}
                    <span className="min-w-0">{n.message}</span>
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted">{whenLabel(n.at)}</p>
                </li>
              ))}
            </ul>
          )}
          <footer className="border-t border-border px-3 py-2">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                navigate("/automatisation");
              }}
              className="text-[11px] text-accent-ink hover:underline"
            >
              Gérer les alertes
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}
