import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Hafta 3'te SSE bu proxy üzerinden gelecek.
    proxy: { "/rooms": "http://localhost:8787", "/health": "http://localhost:8787" },
  },
});
