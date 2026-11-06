/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

/**
 * Préférence de thème commune à la suite (docs/SUITE.md §1.5) : `atelier-theme.js` (copie verbatim) est recopié
 * en script bloquant au tout début de <head>, pour poser le thème avant le premier affichage (aucun flash),
 * en développement comme dans l'interface compilée. Avant lui, reprise unique de l'ancienne clé `theme` d'Atelier Viz.
 */
function atelierTheme(): Plugin {
  const file = new URL("./src/styles/atelier-brand/atelier-theme.js", import.meta.url);
  const migrate =
    'try{var o=localStorage.getItem("theme");if((o==="light"||o==="dark")&&!localStorage.getItem("atelier:theme"))localStorage.setItem("atelier:theme",o);localStorage.removeItem("theme")}catch(e){}';
  return {
    name: "atelier-theme",
    transformIndexHtml: () => [{ tag: "script", children: `${migrate}\n${readFileSync(file, "utf8")}`, injectTo: "head-prepend" }],
  };
}

export default defineConfig({
  plugins: [atelierTheme(), react(), tailwindcss()],
  // docs/SUITE.md §2 : 127.0.0.1:5173, échec explicite si le port est pris.
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    // Le front appelle /api/... ; Vite relaie vers FastAPI (pas de CORS en dev).
    // `changeOrigin: false` : les en-têtes Host (127.0.0.1:5173) et Origin d'origine arrivent tels quels
    // au garde « requêtes locales » de l'API (backend/app/core/local_only.py), qui les accepte.
    proxy: { "/api": { target: "http://127.0.0.1:8000", changeOrigin: false } },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
});
