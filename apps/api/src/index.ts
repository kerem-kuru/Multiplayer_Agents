import { serve } from "@hono/node-server";
import { closePool } from "@agent-rooms/core";
import { createApp } from "./app.js";
import { loadApiConfig } from "./config.js";

const cfg = loadApiConfig();
const app = createApp(cfg);

const server = serve({ fetch: app.fetch, port: cfg.port }, (info) => {
  console.log(`agent-rooms api  http://localhost:${info.port}`);
  console.log(`  oda imajı      ${cfg.roomImage}`);
  console.log(`  oda klasörleri ${cfg.roomsDataDir}`);
  console.log(`  container      ${cfg.spawnContainer ? "açık" : "kapalı (SPAWN_CONTAINER=0)"}`);
});

// Oda container'ları bilerek ayakta bırakılır — sunucu yeniden başlayınca
// oturum devam etsin. Temizlik `POST /rooms/:id/stop` ile.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      void closePool().finally(() => process.exit(0));
    });
  });
}
