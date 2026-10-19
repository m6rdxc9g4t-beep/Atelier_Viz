/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // docs/SUITE.md §2 : 127.0.0.1:5173, échec explicite si le port est pris.
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    // Le front appelle /api/... ; Vite relaie vers FastAPI (pas de CORS en dev).
    proxy: { "/api": "http://localhost:8000" },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
});
