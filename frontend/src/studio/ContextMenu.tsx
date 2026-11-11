import clsx from "clsx";
import type { LucideIcon } from "lucide-react";
import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  hint?: string;
  disabled?: boolean;
  onSelect?: () => void;
}

interface Props {
  x: number;
  y: number;
  title?: string;
  items: MenuItem[];
  onClose: () => void;
}

/**
 * Menu contextuel (clic droit, bouton « Exporter ») : rendu dans <body>, gardé dans la fenêtre, fermé par Échap ou un
 * clic ailleurs. Au clavier : flèches haut / bas, Début et Fin parcourent les entrées ; Échap, Tab ou un choix rendent
 * le focus à l'élément qui a ouvert le menu.
 */
export function ContextMenu({ x, y, title, items, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  // Élément qui avait le focus à l'ouverture (bouton du menu) : il le reprend à la fermeture au clavier ou après un choix.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null));
  const restoreFocus = useCallback(() => {
    if (opener?.isConnected) opener.focus();
  }, [opener]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({ left: Math.max(4, Math.min(x, window.innerWidth - width - 4)), top: Math.max(4, Math.min(y, window.innerHeight - height - 4)) });
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [x, y]);

  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape" && e.key !== "Tab") return;
      if (e.type === "pointerdown" && ref.current?.contains(e.target as Node)) return;
      if (e instanceof KeyboardEvent) {
        // Tab ne part pas dans la page derrière le menu : il le ferme, comme Échap.
        e.preventDefault();
        restoreFocus();
      }
      onClose();
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [onClose, restoreFocus]);

  /** Flèches, Début, Fin : d'une entrée active à l'autre, en boucle. */
  const onKeyDown = (e: ReactKeyboardEvent) => {
    const entries = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    if (!entries.length) return;
    const at = entries.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? (at + 1) % entries.length : e.key === "ArrowUp" ? (at <= 0 ? entries.length - 1 : at - 1) : e.key === "Home" ? 0 : e.key === "End" ? entries.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    entries[next]?.focus();
  };

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={title ?? "Menu"}
      className="atelier-pop fixed z-[60] min-w-56 max-w-80 rounded-lg border border-border bg-surface p-1 text-xs text-fg shadow-xl"
      style={pos}
      onContextMenu={(e) => e.preventDefault()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      {title && <p className="truncate px-2 pt-1 pb-1.5 text-[11px] text-muted">{title}</p>}
      {items.map((item, i) => (
        <button
          key={i}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => {
            // Avant l'action : un dialogue ouvert par l'entrée retient ce déclencheur et lui rendra le focus.
            restoreFocus();
            item.onSelect?.();
            onClose();
          }}
          className={clsx("flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left", item.disabled ? "cursor-default text-muted" : "hover:bg-surface-2 focus:bg-surface-2 focus:outline-none")}
        >
          {item.icon && <item.icon className={clsx("mt-px size-3.5 shrink-0", !item.disabled && "text-muted")} aria-hidden />}
          <span className="min-w-0 flex-1">
            <span className="block">{item.label}</span>
            {item.hint && <span className="block text-[11px] text-muted">{item.hint}</span>}
          </span>
        </button>
      ))}
    </div>,
    // En plein écran (présentation), seul l'élément affiché en plein écran est visible.
    document.fullscreenElement ?? document.body,
  );
}
