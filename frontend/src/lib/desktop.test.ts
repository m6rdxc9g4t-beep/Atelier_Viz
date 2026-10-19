import { afterEach, describe, expect, it, vi } from "vitest";

import { blobToBase64, desktopBridge, openExternal, saveFile } from "./desktop";

type W = Window & { pywebview?: unknown };

afterEach(() => {
  delete (window as W).pywebview;
  vi.restoreAllMocks();
});

describe("pont avec l'application de bureau", () => {
  it("encode un fichier en base64, même volumineux", async () => {
    expect(await blobToBase64(new Blob(["Bonjour"]))).toBe(btoa("Bonjour"));
    const big = new Uint8Array(200_000).map((_, i) => i % 256);
    const decoded = Uint8Array.from(atob(await blobToBase64(new Blob([big]))), (c) => c.charCodeAt(0));
    expect(decoded).toEqual(big);
  });

  it("dans un navigateur : téléchargement et nouvel onglet", async () => {
    expect(desktopBridge()).toBeNull();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    expect(await saveFile(new Blob(["a"]), "a.pptx")).toEqual({ kind: "downloaded" });
    expect(click).toHaveBeenCalledOnce();
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    openExternal("https://exemple.fr");
    expect(open).toHaveBeenCalledWith("https://exemple.fr", "_blank", "noopener,noreferrer");
  });

  it("dans l'application : boîte « Enregistrer sous » et navigateur par défaut", async () => {
    const save_file = vi.fn().mockResolvedValueOnce({ saved: "/Users/f/Ventes.pptx" }).mockResolvedValueOnce({ saved: null }).mockResolvedValueOnce({ saved: null, error: "Disque plein" });
    const open_external = vi.fn().mockResolvedValue(true);
    (window as W).pywebview = { api: { save_file, open_external } };
    expect(await saveFile(new Blob(["PK"]), "Ventes.pptx")).toEqual({ kind: "saved", path: "/Users/f/Ventes.pptx" });
    expect(save_file).toHaveBeenCalledWith("Ventes.pptx", btoa("PK"));
    expect(await saveFile(new Blob(["PK"]), "Ventes.pptx")).toEqual({ kind: "cancelled" });
    await expect(saveFile(new Blob(["PK"]), "Ventes.pptx")).rejects.toThrow("Disque plein");
    const open = vi.spyOn(window, "open");
    openExternal("https://microsoft.com/devicelogin");
    expect(open_external).toHaveBeenCalledWith("https://microsoft.com/devicelogin");
    expect(open).not.toHaveBeenCalled();
  });
});
