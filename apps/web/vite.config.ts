import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // /api → sunucu. SSE'nin tamponlanmamasi icin compress kapali.
      "/api": {
        target: process.env.API_URL ?? "http://localhost:8787",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            // Ters vekil akisi tamponlamasin.
            proxyRes.headers["x-accel-buffering"] = "no";
          });
        },
      },
    },
  },
});
