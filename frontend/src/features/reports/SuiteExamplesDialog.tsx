import { X } from "lucide-react";
import { useEffect, useId } from "react";
import { createPortal } from "react-dom";

import { useModalFocus } from "../../hooks/useModalFocus";
import { api } from "../../lib/api";
import { onExamplesChange } from "../../lib/exemples";
import { navigate, parseRoute } from "../../lib/router";
import { SuiteExamples } from "./SuiteExamples";

/**
 * « Exemples de la suite » en dialogue, ouvert depuis le pied de la barre latérale (comme dans Atelier Tab) :
 * choisir une histoire, la charger et ouvrir son rapport, ou la retirer. Toute la logique est celle de
 * `SuiteExamples` ; le dialogue n'ajoute que son cadre (focus retenu, Échap, focus rendu au bouton).
 */
export function SuiteExamplesDialog({ onClose }: { onClose: () => void }) {
  const titleId = useId();
  const dialogRef = useModalFocus<HTMLDivElement>();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Histoire retirée alors que son rapport est ouvert dans le Studio : il n'existe plus, retour à l'accueil.
  useEffect(
    () =>
      onExamplesChange(() => {
        const route = parseRoute(window.location.hash);
        if (route.name !== "studio") return;
        void api.reports.list().then(
          (list) => {
            if (!list.some((r) => r.id === route.id)) navigate("/");
          },
          () => undefined,
        );
      }),
    [],
  );

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="atelier-pop relative flex max-h-[88dvh] w-full max-w-2xl flex-col overflow-y-auto rounded-xl border border-border bg-surface text-fg shadow-2xl"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Fermer"
          className="absolute top-2.5 right-2.5 z-10 flex size-7 items-center justify-center rounded text-muted hover:bg-surface-2 hover:text-fg pointer-coarse:size-10"
        >
          <X className="size-4" aria-hidden />
        </button>
        <SuiteExamples variant="dialog" titleId={titleId} onOpen={onClose} />
      </div>
    </div>,
    document.body,
  );
}
