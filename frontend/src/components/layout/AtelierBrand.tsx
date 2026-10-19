import { useId, useRef } from "react";
import { BarChart3 } from "lucide-react";

import logo from "../../assets/logo-atelier-viz.webp";

/**
 * Marque commune de la Suite Atelier (styles/atelier-brand, docs/SUITE.md §1.6) :
 * tuile + « atelier_Viz » ; un clic ouvre la fenêtre « À propos » avec le logo en grand.
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
        <span className="atelier-brand__tile" aria-hidden="true">
          <BarChart3 />
        </span>
        {showName && (
          <span className={`atelier-brand__name ${nameClassName}`}>
            <span className="atelier-brand__prefix">atelier_</span>Viz
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
            ×
          </button>
          <img className="atelier-about__logo" src={logo} alt="Logo Atelier Viz" width={576} height={526} />
          <h2 id={titleId} className="atelier-about__name">
            <span className="atelier-brand__prefix">atelier_</span>Viz
          </h2>
          <p className="atelier-about__tagline">Rapports et tableaux de bord dans l'esprit de Power BI, sur vos données, sans qu'elles quittent la machine.</p>
          <p className="atelier-about__suite">Suite Atelier · 100 % local</p>
        </div>
      </dialog>
    </>
  );
}
