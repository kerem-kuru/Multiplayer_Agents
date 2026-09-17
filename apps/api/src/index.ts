import path from "node:path";
import { serve } from "@hono/node-server";
import { AgentManager, closePool } from "@agent-rooms/core";
import { createApp } from "./app.js";
import { REPO_ROOT, loadApiConfig } from "./config.js";

// .env'i Node'un kendi yükleyicisiyle oku — dotenv bağımlılığı yok.
// Ortamda zaten tanımlı değişkenler ezilmez.
try {
  process.loadEnvFile(path.join(REPO_ROOT, ".env"));
} catch {
  // .env yoksa sorun değil: her ayarın varsayılanı var.
}

const cfg = loadApiConfig();

/**
 * Anahtar yoksa agent yöneticisi hiç kurulmaz: oda açma ve event okuma
 * çalışmaya devam eder, agent uçları 503 döner. Sessizce yarım çalışan bir
 * sunucudan iyidir.
 */
const manager = cfg.agent.apiKey
  ? new AgentManager({
      apiKey: cfg.agent.apiKey,
      modelOverride: cfg.agent.modelOverride || undefined,
      maxTurns: cfg.agent.maxTurns,
      maxBudgetUsd: cfg.agent.maxBudgetUsd,
      heartbeatTimeoutMs: cfg.agent.heartbeatTimeoutMs,
      log: (level, msg) => console[level === "info" ? "log" : level](msg),
    })
  : undefined;

if (manager) {
  // Sunucu çöküp kalktıysa DB "busy" diyor olabilir; gerçeği yaz.
  const settled = await manager.reconcileOnBoot().catch((err) => {
    console.error("açılış mutabakatı başarısız:", err);
    return 0;
  });
  if (settled > 0) console.log(`açılış mutabakatı: ${settled} agent stopped'a çekildi`);
  manager.startHealthChecks();
}

const app = createApp(cfg, manager);

const server = serve({ fetch: app.fetch, port: cfg.port }, (info) => {
  console.log(`agent-rooms api  http://localhost:${info.port}`);
  console.log(`  oda imajı      ${cfg.roomImage}`);
  console.log(`  oda klasörleri ${cfg.roomsDataDir}`);
  console.log(`  container      ${cfg.spawnContainer ? "açık" : "kapalı (SPAWN_CONTAINER=0)"}`);
  console.log(
    `  agent          ${manager ? `açık (model: ${cfg.agent.modelOverride || "YAML"})` : "KAPALI — ANTHROPIC_API_KEY yok"}`,
  );
});

// Oda container'ları bilerek ayakta bırakılır — sunucu yeniden başlayınca
// oturum devam etsin. Ama runner'lara kibar kapanma gönderilir ki container
// içinde sahipsiz süreç kalmasın.
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const done = (): void => {
      server.close(() => {
        void closePool().finally(() => process.exit(0));
      });
    };
    if (!manager) return done();
    // En fazla 5 sn bekle, sonra yine de kapan.
    const timer = setTimeout(done, 5_000);
    void manager.shutdownAll().finally(() => {
      clearTimeout(timer);
      done();
    });
  });
}
