import clsx from "clsx";
import { FileUp, Loader2 } from "lucide-react";
import { type DragEvent, useRef, useState } from "react";

const ACCEPT = ".csv,.tsv,.txt,.xlsx,.json";

interface UploadDropzoneProps {
  onFile: (file: File) => void;
  uploading: boolean;
  /** `large` : état vide plein écran ; `compact` : bouton dans la barre d'outils. */
  variant?: "large" | "compact";
}

/** Zone de dépôt + sélecteur de fichier (CSV, XLSX, JSON). */
export function UploadDropzone({ onFile, uploading, variant = "large" }: UploadDropzoneProps) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const open = () => input.current?.click();
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const file = e.dataTransfer.files[0];
    if (file) onFile(file);
  };

  const hiddenInput = (
    <input
      ref={input}
      type="file"
      accept={ACCEPT}
      className="sr-only"
      aria-label="Choisir un fichier de données"
      onChange={(e) => {
        const file = e.target.files?.[0];
        if (file) onFile(file);
        e.target.value = "";
      }}
    />
  );

  if (variant === "compact") {
    return (
      <>
        {hiddenInput}
        <button
          type="button"
          onClick={open}
          disabled={uploading}
          className="atelier-btn-primary flex h-8 items-center gap-2 rounded-md bg-accent px-3 text-xs font-medium text-accent-fg disabled:opacity-50"
        >
          {uploading ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <FileUp className="size-3.5" aria-hidden />}
          Importer
        </button>
      </>
    );
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={clsx(
        "flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-6 py-16 text-center transition-colors",
        over ? "border-accent-ink bg-accent/5" : "border-border bg-surface",
      )}
    >
      {hiddenInput}
      {uploading ? (
        <Loader2 className="size-8 animate-spin text-muted" aria-hidden />
      ) : (
        <FileUp className="size-8 text-muted" aria-hidden />
      )}
      <div>
        <p className="text-sm font-medium">Déposez un fichier de données</p>
        <p className="mt-1 text-xs text-muted">CSV (séparateur , ou ;), Excel .xlsx ou JSON — 50 Mo max</p>
      </div>
      <button
        type="button"
        onClick={open}
        disabled={uploading}
        className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-2 disabled:opacity-50"
      >
        Parcourir…
      </button>
    </div>
  );
}
