import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // expose on the LAN so the app is reachable from other devices (phones)
    host: true,
    // Cross-origin isolation: enables SharedArrayBuffer for the multi-threaded
    // Stockfish builds (see src/engine/). Must also be sent by the prod server.
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
    // The SQLite data API lives in the Bun server — run it alongside in dev:
    //   bun server/index.ts
    proxy: {
      "/api/db": "http://localhost:3000",
    },
  },
});
