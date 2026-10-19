/**
 * Pont avec l'application de bureau (fenêtre pywebview, backend/app/desktop.py).
 *
 * Dans un navigateur, `window.pywebview` n'existe pas : les fichiers se téléchargent et les liens
 * s'ouvrent dans un nouvel onglet, comme d'habitude. Dans l'application, une vraie boîte
 * « Enregistrer sous » s'ouvre et les liens partent dans le navigateur par défaut.
 */

interface DesktopBridge {
  save_file: (name: string, dataBase64: string) => Promise<{ saved: string | null; error?: string }>;
  open_external: (url: string) => Promise<boolean>;
}

/** Résultat d'un enregistrement de fichier. */
export type SaveOutcome = { kind: "downloaded" } | { kind: "saved"; path: string } | { kind: "cancelled" };

/** Pont de l'application de bureau, ou null dans un navigateur. */
export function desktopBridge(): DesktopBridge | null {
  const api = (window as unknown as { pywebview?: { api?: Partial<DesktopBridge> } }).pywebview?.api;
  return api && typeof api.save_file === "function" && typeof api.open_external === "function" ? (api as DesktopBridge) : null;
}

/** Contenu d'un fichier en base64 (par morceaux : pas de dépassement de pile sur un gros fichier). */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

/** Enregistre un fichier : boîte « Enregistrer sous » dans l'application, téléchargement dans un navigateur. */
export async function saveFile(blob: Blob, fileName: string): Promise<SaveOutcome> {
  const bridge = desktopBridge();
  if (bridge) {
    const res = await bridge.save_file(fileName, await blobToBase64(blob));
    if (res.error) throw new Error(res.error);
    return res.saved ? { kind: "saved", path: res.saved } : { kind: "cancelled" };
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { kind: "downloaded" };
}

/** Ouvre un lien externe : navigateur par défaut depuis l'application, nouvel onglet sinon. */
export function openExternal(url: string): void {
  const bridge = desktopBridge();
  if (bridge) void bridge.open_external(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}
