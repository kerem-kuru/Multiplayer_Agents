import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * `WEB_ALLOWED_HOSTS` — tünelle dışarı açarken gerekir.
 *
 * Vite 5.4'ten beri geliştirme sunucusu, Host başlığı localhost olmayan
 * istekleri reddediyor (DNS yeniden bağlama saldırısına karşı). Tünel adresi
 * de "localhost olmayan" bir host, yani açıkça izin vermek gerekiyor.
 *
 * Varsayılan KAPALI: izin listesi ancak sen verirsen genişler.
 *   WEB_ALLOWED_HOSTS="filan.trycloudflare.com"   # tek host
 *   WEB_ALLOWED_HOSTS="*"                          # kontrolü tamamen kapat
 */
const allowedHosts =
  process.env.WEB_ALLOWED_HOSTS === "*"
    ? true
    : (process.env.WEB_ALLOWED_HOSTS ?? "")
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean);

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // WEB_HOST=1: 0.0.0.0'a bağlan (tünel ve aynı ağdaki başka makine için).
    host: process.env.WEB_HOST === "1",
    ...(Array.isArray(allowedHosts) && allowedHosts.length === 0 ? {} : { allowedHosts }),
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
