import { useId, useRef } from "react";
import { ChartColumn, X } from "lucide-react";

/**
 * Marque commune de la Suite Atelier (styles/atelier-brand, docs/SUITE.md §1.6) : icône carrée en dégradé de
 * la signature (glyphe Lucide `chart-column` blanc) + « Atelier Viz » ; un clic ouvre la fenêtre « À propos ».
 */
export function AtelierBrand({ showName = true, nameClassName = "" }: { showName?: boolean; nameClassName?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  return (
    <>
      <button
        type="button"
        className="atelier-brand"
        aria-haspopup="dialog"
        aria-label={showName ? undefined : "À propos d'Atelier Viz"}
        title="À propos d'Atelier Viz"
        onClick={() => dialog.current?.showModal()}
      >
        <span className="atelier-brand__tile atelier-brand__tile--sm" aria-hidden="true">
          <ChartColumn />
        </span>
        {showName && (
          <span className={`atelier-brand__name ${nameClassName}`}>
            <span className="atelier-brand__prefix">Atelier </span>Viz
          </span>
        )}
      </button>

      <dialog
        ref={dialog}
        className="atelier-about"
        aria-labelledby={titleId}
        onClick={(e) => {
          if (e.target === e.currentTarget) e.currentTarget.close();
        }}
      >
        <div className="atelier-about__panel">
          <button type="button" className="atelier-about__close" aria-label="Fermer" onClick={() => dialog.current?.close()}>
            <X className="size-4" aria-hidden />
          </button>
          <span className="atelier-about__icon atelier-brand__tile" aria-hidden="true">
            <ChartColumn />
          </span>
          <h2 id={titleId} className="atelier-about__name">
            <span className="atelier-brand__prefix">Atelier </span>Viz
          </h2>
          <p className="atelier-about__tagline">Rapports et tableaux de bord dans l'esprit de Power BI, sur vos données, sans qu'elles quittent la machine.</p>
          <p className="atelier-about__suite">Suite Atelier · 100 % local</p>
        </div>
      </dialog>
    </>
  );
}
