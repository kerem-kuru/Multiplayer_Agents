import path from "node:path";
import { serve } from "@hono/node-server";
import {
  AgentManager,
  AgentQueue,
  FakeAgentRuntime,
  closePool,
  configureSnapshots,
  createRedactingLogger,
  getDriverWatcher,
  startIsolationAudit,
  startSweeper,
  sweepAbsentDrivers,
  sweepOrphans,
} from "@agent-rooms/core";
import { collectProviderEnv, hasProviderBackend } from "@agent-rooms/protocol";
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

// Snapshot üretimi sessizce ölmemeli: üretilemezse tam replay'e düşülür ama
// bunu bilmek gerekir.
configureSnapshots({
  onError: (err) => console.warn("snapshot üretilemedi:", String(err)),
});

// Bedrock/Vertex/gateway seçiliyse API anahtarı GEREKMEZ — kimlik doğrulama
// dışarıdan gelir (AWS kimlikleri, gcloud ADC).
const providerEnv = collectProviderEnv(process.env);
const provider = hasProviderBackend(process.env);

/**
 * Ne anahtar ne sağlayıcı varsa agent yöneticisi hiç kurulmaz: oda açma ve
 * event okuma çalışmaya devam eder, agent uçları 503 döner. Sessizce yarım
 * çalışan bir sunucudan iyidir.
 */
// Koşum ortamlarından HERHANGİ biri kullanılabilirse yönetici kurulur.
// Claude anahtarı yokken Gemini agent'ları çalışmaya devam eder.
const anyRuntime = Boolean(cfg.agent.apiKey) || provider || Boolean(cfg.agent.geminiApiKey);

/**
 * SAHTE koşum ortamı yalnızca kapı testleri için ve açıkça isteniyorsa
 * (`AGENT_FAKE_RUNTIME=1`, üretimde asla). Ekranda da söylenir: sessizce
 * sahte cevap veren bir sunucu, hiç cevap vermeyenden kötüdür.
 */
const manager = cfg.agent.fakeRuntime
  ? new FakeAgentRuntime({
      turnMs: cfg.agent.fakeTurnMs,
      log: (level, msg) => console[level === "info" ? "log" : level](msg),
    })
  : anyRuntime
  ? new AgentManager({
      apiKey: cfg.agent.apiKey,
      geminiApiKey: cfg.agent.geminiApiKey,
      modelOverride: cfg.agent.modelOverride || undefined,
      modelOverrides: cfg.agent.modelOverrides,
      providerEnv,
      maxTurns: cfg.agent.maxTurns,
      maxBudgetUsd: cfg.agent.maxBudgetUsd,
      retryBudget: cfg.agent.retryBudget,
      heartbeatTimeoutMs: cfg.agent.heartbeatTimeoutMs,
      // Secret'ı event log'dan temizleyip stdout'a basmak bir şey kazandırmaz:
      // runner stderr'i de buradan geçiyor.
      log: createRedactingLogger((level, msg) =>
        console[level === "info" ? "log" : level](msg),
      ),
    })
  : undefined;

/**
 * Kuyruk, manager'ın olduğu her yerde vardır: yazmanın tek kapısı o.
 * Manager yoksa (hiç koşum ortamı yok) kuyruk da kurulmaz ve yazma uçları
 * `503` döner — sessizce kabul edip hiçbir şey yapmamaktan iyi.
 */
const queueLog = createRedactingLogger((level, msg) =>
  console[level === "info" ? "log" : level](msg),
);

const queue = manager ? new AgentQueue({ deliverer: manager, log: queueLog }) : undefined;

if (manager && queue) {
  manager.attachSink(queue);

  // Sunucu çöküp kalktıysa DB "busy" diyor olabilir; gerçeği yaz.
  const settled = await manager.reconcileOnBoot().catch((err) => {
    console.error("açılış mutabakatı başarısız:", err);
    return 0;
  });
  if (settled > 0) console.log(`açılış mutabakatı: ${settled} agent stopped'a çekildi`);

  /**
   * Kuyruk mutabakatı: `running` kalmış satırlar iptal (yeniden koşturma YOK),
   * `queued` satırlar KORUNUR ve akmaya devam eder. Kuyruğun DB'de olmasının
   * bütün sebebi bu.
   */
  const q = await queue.reconcileOnBoot().catch((err) => {
    console.error("kuyruk mutabakatı başarısız:", err);
    return { cancelled: 0, resumed: 0 };
  });
  if (q.cancelled > 0 || q.resumed > 0) {
    console.log(`kuyruk mutabakatı: ${q.cancelled} iptal, ${q.resumed} agent kuyruğu akıyor`);
  }

  manager.startHealthChecks();
}

/**
 * Sürücü mutabakatı: presence bellekte olduğu için açılışta oda boş. DB'de
 * sürücü yazıyorsa bırakılır — yoksa yeniden bağlanan kullanıcı kendi
 * sürücülüğünü geri alamaz ve `409` görür.
 */
const droppedDrivers = await sweepAbsentDrivers().catch(() => 0);
if (droppedDrivers > 0) console.log(`sürücü mutabakatı: ${droppedDrivers} sürücülük bırakıldı`);

// Sürücünün presence'ı 60 sn kayıpsa sürücülük düşer (bkz. DriverPresenceWatcher).
getDriverWatcher({
  // Varsayilan 60 sn. `DRIVER_GRACE_MS` yalnizca deneme/kapi icin kisaltir:
  // sekme yenilemek suruculugu elinden almasin diye bir gecikme SART.
  graceMs: process.env.DRIVER_GRACE_MS ? Number(process.env.DRIVER_GRACE_MS) : undefined,
  log: (level, msg) => console[level === "info" ? "log" : level](msg),
});

/**
 * Sahipsiz container ve volume temizligi (Hafta 7, Adim 10).
 *
 * Acilista bir kez + saatte bir. Docker yeniden baslatildiginda ya da bir oda
 * elle silindiginde geride kalan container/volume'lar birikmesin. Event log'a
 * YAZMAZ: silinen oda artik yok.
 */
const sweepNotice = (level: "info" | "warn", message: string): void =>
  level === "warn" ? console.warn(message) : console.log(message);
const firstSweep = await sweepOrphans(undefined, sweepNotice).catch((err) => {
  console.error("sweeper acilista dustu:", err);
  return null;
});
if (firstSweep) {
  const n =
    firstSweep.removedContainers.length +
    firstSweep.removedVolumes.length +
    firstSweep.failedRooms.length;
  if (n > 0) {
    console.log(
      `sweeper: ${firstSweep.removedContainers.length} container, ` +
        `${firstSweep.removedVolumes.length} volume silindi, ` +
        `${firstSweep.failedRooms.length} oda failed`,
    );
  }
}
startSweeper(undefined, undefined, sweepNotice);

/**
 * Izin denetimi (Hafta 7, Adim 9): 5 dakikada bir tum odalar.
 *
 * Runner turn sonunda kendi klasorunu zaten olcuyor; bu ikinci kopya agent
 * BOSTAYKEN yapilan degisiklikleri yakaliyor.
 */
startIsolationAudit(undefined, undefined, (msg) => console.warn(msg));

const app = createApp(cfg, manager, queue);

const server = serve({ fetch: app.fetch, port: cfg.port }, (info) => {
  console.log(`agent-rooms api  http://localhost:${info.port}`);
  console.log(`  oda imajı      ${cfg.roomImage}`);
  console.log(`  oda klasörleri ${cfg.roomsDataDir}`);
  console.log(`  container      ${cfg.spawnContainer ? "açık" : "kapalı (SPAWN_CONTAINER=0)"}`);
  const backend = provider
    ? Object.keys(providerEnv)
        .filter((k) => k.startsWith("CLAUDE_CODE_USE_"))
        .map((k) => k.replace("CLAUDE_CODE_USE_", "").toLowerCase())
        .join(",") || "özel base URL"
    : "anthropic";
  const runtimes = cfg.agent.fakeRuntime
    ? ["SAHTE (AGENT_FAKE_RUNTIME=1 — hiçbir modele istek gitmiyor)"]
    : [
        cfg.agent.apiKey || provider ? `claude(${backend})` : null,
        cfg.agent.geminiApiKey ? "gemini" : null,
      ].filter(Boolean);
  console.log(
    `  koşum ortamı   ${runtimes.length > 0 ? runtimes.join(" + ") : "YOK — hiçbir anahtar tanımlı değil"}`,
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
