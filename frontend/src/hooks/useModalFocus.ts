import { type RefObject, useEffect, useRef, useState } from "react";

const FOCUSABLE = "a[href], button, input, select, textarea, [tabindex]";

/** Éléments atteignables par Tab dans `root`, dans l'ordre du document. */
export function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) => el.tabIndex >= 0 && !(el as HTMLButtonElement).disabled && !(el instanceof HTMLInputElement && el.type === "hidden") && !el.closest("[hidden], [inert]"),
  );
}

// Dialogues ouverts, du plus ancien au plus récent : seul le dernier retient le focus.
const stack: RefObject<HTMLElement | null>[] = [];

/**
 * Focus d'un dialogue modal (`role="dialog"` + `aria-modal`) : à l'ouverture le focus entre dans le dialogue (s'il n'y
 * est pas déjà : `autoFocus`, champ visé par le dialogue), Tab et Maj+Tab y bouclent au lieu de partir dans la page
 * masquée, et à la fermeture le focus revient à l'élément qui l'a ouvert. À poser sur l'élément du dialogue :
 * `const ref = useModalFocus<HTMLDivElement>(); … <div ref={ref} role="dialog" aria-modal="true">`.
 */
export function useModalFocus<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T>(null);
  // Lu au premier rendu, avant qu'un `autoFocus` ou un effet du dialogue ne déplace le focus.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    stack.push(ref);
    if (!root.contains(document.activeElement)) {
      if (!root.hasAttribute("tabindex")) {
        root.tabIndex = -1;
        root.style.outline = "none";
      }
      root.focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || stack[stack.length - 1] !== ref) return;
      // Tab déjà traité (un menu ouvert dans le dialogue se ferme et rend le focus) : rien à déplacer.
      if (e.defaultPrevented) return;
      const items = focusables(root);
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        e.preventDefault();
        return;
      }
      const active = document.activeElement;
      if (!root.contains(active) || active === root) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      const at = stack.lastIndexOf(ref);
      if (at >= 0) stack.splice(at, 1);
      if (opener?.isConnected) opener.focus();
    };
  }, [opener]);

  return ref;
}
