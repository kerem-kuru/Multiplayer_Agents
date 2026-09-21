import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Actor, AgentConfig, NewRoomEvent, RoomConfig } from "@agent-rooms/protocol";
import { PROTOCOL_VERSION, RunnerOutput, collectProviderEnv } from "@agent-rooms/protocol";
import { appendEvent } from "../db/eventStore.js";
import { getPool } from "../db/pool.js";
import {
  GitkitError,
  getCheckpoint,
  initWorkspace as gitkitInitWorkspace,
  recordCheckpoint,
} from "../diff.js";
import { containerStatus, roomContainerName } from "../docker/container.js";
import { getRoomConfig, latestSession } from "../room/rooms.js";
import { killStrayRunners, startRunnerExec, type RunnerExec } from "./exec.js";
import {
  ensureRuntimeRows,
  forceStopped,
  getRuntime,
  listUnsettled,
  transition,
  type AgentStatus,
} from "./runtime.js";

/**
 * Agent süreçlerinin yöneticisi — tek sunucu örneği için, bellekte.
 * (Çok sunuculu dağıtım Redis ile sonraki fazlarda.)
 *
 * İki kural burada yaşıyor:
 *
 * 1. EVENT SIRASI. Bir runner'ın stdout satırları DB'ye GELDİĞİ SIRAYLA
 *    yazılır. Paralel `appendEvent` çağrısı sırayı bozardı — `seq` numaraları
 *    doğru kalır ama olayların anlamı bozulur (tool.result'ın tool.call'dan
 *    önce yazılması gibi). Bu yüzden handle başına tek bir promise zinciri.
 *
 * 2. UÇUŞTAKİ MESAJ TEKRARLANMAZ. Runner çökerse o görev `turn.failed` ile
 *    kapanır ve ASLA yeniden gönderilmez: agent yarısını yapmış olabilir,
 *    tekrar koşmak yan etkiyi ikiye katlar.
 */

export interface AgentManagerOptions {
  pool?: pg.Pool;
  apiKey: string;
  /** YAML'daki model'i ezen global ayar — kapı testleri haiku'ya düşürmek için kullanır. */
  modelOverride?: string;
  /** Gemini koşum ortamı için anahtar. Claude'unkinden bağımsız. */
  geminiApiKey?: string;
  /**
   * Sağlayıcı ortamı (Bedrock/Vertex/gateway). Host ortamından toplanır ve
   * container'a olduğu gibi geçer; oda konfigürasyonuna yazılmaz.
   */
  providerEnv?: Record<string, string>;
  maxTurns?: number;
  maxBudgetUsd?: number;
  heartbeatTimeoutMs?: number;
  readyTimeoutMs?: number;
  log?: (level: "info" | "warn" | "error", msg: string, extra?: unknown) => void;
}

interface AgentHandle {
  roomId: string;
  sessionId: string;
  agent: AgentConfig;
  container: string;
  exec: RunnerExec;
  pid: number | null;
  /** Satırlar birer birer işlensin diye. */
  chain: Promise<void>;
  lastHeartbeat: number;
  stopping: boolean;
  protocolErrors: number;
  restartTimes: number[];
  readyResolve: (() => void) | null;
  readyReject: ((err: Error) => void) | null;
  /**
   * Kesme istenen mesaj. İki iş yapar: çıkış işlenirken `turn.failed`
   * sebebinin `interrupted` olması ve sert kesme sayacının doğru turn'e
   * bakması.
   */
  interruptedMessageId: string | null;
  /** Sert kesme sayacı: 30 sn'de kapanmayan turn için. */
  hardKillTimer: NodeJS.Timeout | null;
}

export class AgentNotFoundError extends Error {}
/** Agent ayağa kalkamadı — sebebi kullanıcıya gösterilebilir. */
export class AgentStartError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AgentStartError";
  }
}

export class AgentBusyError extends Error {
  constructor(readonly status: AgentStatus) {
    super(`agent meşgul: ${status}`);
  }
}

/**
 * Kesme isteğinden sonra runner'a tanınan süre. Bitmezse sert kesme:
 * "kestim" deyip durmamak kullanıcıya yalan söylemektir.
 */
const HARD_KILL_AFTER_MS = 30_000;

const RESTART_WINDOW_MS = 10 * 60 * 1000;
const MAX_RESTARTS = 3;
const RESTART_BACKOFF_MS = [1_000, 4_000, 15_000];
const MAX_PROTOCOL_ERRORS = 10;

/**
 * Kuyruğun manager'a bakan yüzü. `AgentQueue` bunu uygular.
 *
 * Manager kuyruğu tanımaz; yalnızca "bu turn bitti" ve "bu agent kurtarılamadı"
 * der. Sıralama kararı tek yerde (kuyrukta) kalsın diye.
 */
export interface TurnSink {
  finishRunning(roomId: string, agentName: string, messageId: string): Promise<void>;
  agentFailed(roomId: string, agentName: string): Promise<number>;
}

export class AgentManager {
  private readonly handles = new Map<string, AgentHandle>();
  private sink: TurnSink | null = null;
  private readonly pool: pg.Pool;
  private readonly opts: Required<
    Omit<AgentManagerOptions, "pool" | "modelOverride" | "providerEnv" | "geminiApiKey">
  > & {
    modelOverride?: string;
    providerEnv: Record<string, string>;
    geminiApiKey: string;
  };
  private healthTimer: NodeJS.Timeout | null = null;

  constructor(options: AgentManagerOptions) {
    this.pool = options.pool ?? getPool();
    this.opts = {
      apiKey: options.apiKey,
      modelOverride: options.modelOverride,
      providerEnv: options.providerEnv ?? collectProviderEnv(process.env),
      geminiApiKey: options.geminiApiKey ?? "",
      maxTurns: options.maxTurns ?? 30,
      maxBudgetUsd: options.maxBudgetUsd ?? 1,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? 20_000,
      readyTimeoutMs: options.readyTimeoutMs ?? 30_000,
      log: options.log ?? (() => undefined),
    };
  }

  private key(roomId: string, agentName: string): string {
    return `${roomId}:${agentName}`;
  }

  /** Kuyruğu bağla. Bağlanmazsa turn bitişleri kimseye haber verilmez. */
  attachSink(sink: TurnSink): void {
    this.sink = sink;
  }

  private notifyFinished(roomId: string, agentName: string, messageId: string): void {
    void this.sink
      ?.finishRunning(roomId, agentName, messageId)
      .catch((err) => this.opts.log("error", `kuyruk bilgilendirilemedi: ${String(err)}`));
  }

  /** Sağlık kontrolü: heartbeat susan runner ölmüş sayılır. */
  startHealthChecks(): void {
    if (this.healthTimer) return;
    this.healthTimer = setInterval(() => void this.checkHealth(), 5_000);
  }

  stopHealthChecks(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = null;
  }

  private async checkHealth(): Promise<void> {
    const now = Date.now();
    for (const handle of [...this.handles.values()]) {
      if (handle.stopping) continue;
      if (now - handle.lastHeartbeat <= this.opts.heartbeatTimeoutMs) continue;
      this.opts.log("warn", `heartbeat zaman aşımı: ${handle.agent.name}`);
      if (handle.pid) await handle.exec.hardKill(handle.pid).catch(() => undefined);
    }
  }

  private async resolveAgent(roomId: string, agentName: string): Promise<{
    config: RoomConfig;
    agent: AgentConfig;
    sessionId: string;
    container: string;
  }> {
    const config = await getRoomConfig(roomId, this.pool);
    if (!config) throw new AgentNotFoundError(`oda bulunamadı: ${roomId}`);
    const agent = config.agents.find((a) => a.name === agentName);
    if (!agent) throw new AgentNotFoundError(`agent YAML'da yok: ${agentName}`);

    const session = await latestSession(roomId, this.pool);
    if (!session) throw new AgentNotFoundError(`odanın oturumu yok: ${roomId}`);
    const container = session.containerId ?? roomContainerName(roomId);
    return { config, agent, sessionId: session.id, container };
  }

  private write(handle: AgentHandle, event: NewRoomEvent): Promise<unknown> {
    return appendEvent(event, this.pool);
  }

  /**
   * Sistem zarfı. Dönüş tipi `NewRoomEvent` olduğu için payload alanları
   * DERLEMEDE kontrol edilir — yanlış alan adı çalışma zamanına kalmaz.
   */
  private systemEvent(
    handle: AgentHandle,
    event: Extract<NewRoomEvent, { actor: unknown }>,
  ): NewRoomEvent {
    return event;
  }

  // --- başlatma -----------------------------------------------------------

  async start(roomId: string, agentName: string): Promise<AgentStatus> {
    const existing = this.handles.get(this.key(roomId, agentName));
    if (existing) {
      const rt = await getRuntime(roomId, agentName, this.pool);
      return rt?.status ?? "idle";
    }

    const { config, agent, sessionId, container } = await this.resolveAgent(roomId, agentName);
    await ensureRuntimeRows(roomId, config.agents.map((a) => a.name), this.pool);

    const before = await getRuntime(roomId, agentName, this.pool);
    const resumeSessionId = before?.sdkSessionId ?? null;

    await transition(roomId, agentName, "starting", {}, this.pool);
    await appendEvent(
      {
        roomId,
        sessionId,
        actor: { kind: "system" },
        type: "agent.starting",
        payload: { agent: agentName, resumeSessionId },
      } satisfies NewRoomEvent,
      this.pool,
    );

    const env: Record<string, string> = {
      // Sağlayıcı değişkenleri önce: aşağıdakiler onları ezmesin.
      ...this.opts.providerEnv,
      ROOM_ID: roomId,
      SESSION_ID: sessionId,
      ROOM_AGENT_CONFIG: JSON.stringify(agent),
      AGENT_MODEL: this.opts.modelOverride || agent.model,
      AGENT_MAX_TURNS: String(this.opts.maxTurns),
      AGENT_MAX_BUDGET_USD: String(this.opts.maxBudgetUsd),
    };
    // Her koşum ortamı KENDİ anahtarını alır; diğerininkini görmez.
    if (agent.runtime === "gemini") {
      if (this.opts.geminiApiKey) env.GEMINI_API_KEY = this.opts.geminiApiKey;
    } else {
      // Bedrock/Vertex'te anahtar yoktur; boş değişken geçirmek SDK'yı şaşırtır.
      if (this.opts.apiKey) env.ANTHROPIC_API_KEY = this.opts.apiKey;
    }
    if (resumeSessionId) env.RESUME_SESSION_ID = resumeSessionId;

    /**
     * DİFF TABANI — runner'dan ÖNCE, sunucu tarafından.
     *
     * Runner kendi tabanını üretseydi "diff neye göre" sorusunun iki cevabı
     * olurdu: agent yeniden başlatıldığında taban kayar ve önceki turn'lerin
     * değişiklikleri sessizce kaybolurdu. Taban bir kez alınır ve
     * `agent_runtime.diff_base_checkpoint_id`'de durur.
     *
     * Taban alınamazsa agent YİNE BAŞLAR: diff bir sunum katmanı, agent'ın
     * çalışmasının önkoşulu değil. Sadece canlı diff yayımlanmaz ve sebep
     * loga yazılır.
     */
    const base = await this.ensureDiffBase(roomId, agentName, container, agent.workspace, sessionId);
    if (base) {
      env.DIFF_BASE_CHECKPOINT_ID = base.checkpointId;
      env.DIFF_BASE_TREE = base.treeSha;
    }

    /**
     * Buradan sonrası başarısız olursa runtime `starting`de KALMAMALI.
     *
     * Gerçekte oldu: odanın container'ı dışarıdan silinince (docker prune,
     * elle temizlik) `start` 404 alıyor, hata yukarı gidiyor ve agent sonsuza
     * kadar "starting" görünüyordu — ekranda tek kelime açıklama olmadan.
     * Ayağa kalkamamak bir sonuçtur; sessizlik değil.
     */
    let exec;
    try {
      exec = await startRunnerExec({
        container,
        workdir: `/room/${agent.workspace}`,
        env,
        user: "agent",
        runnerPath: `/opt/runner/${agent.runtime}/dist/runner.js`,
      });
    } catch (err) {
      const missing =
        (err as { statusCode?: number }).statusCode === 404 ||
        /no such container/i.test(String(err));
      const reason = missing
        ? "odanın container'ı yok (silinmiş olabilir) — odayı yeniden aç"
        : `container'a bağlanılamadı: ${String(err)}`;

      await transition(roomId, agentName, "failed", { lastError: reason }, this.pool);
      await appendEvent(
        {
          roomId,
          sessionId,
          actor: { kind: "system" },
          type: "agent.crashed",
          payload: {
            agent: agentName,
            exitCode: null,
            error: reason,
            willRestart: false,
            restartCount: 0,
          },
        } satisfies NewRoomEvent,
        this.pool,
      );
      this.opts.log("error", `agent başlatılamadı (${agentName}): ${reason}`);
      throw new AgentStartError(reason, { cause: err });
    }

    const handle: AgentHandle = {
      roomId,
      sessionId,
      agent,
      container,
      exec,
      pid: null,
      chain: Promise.resolve(),
      lastHeartbeat: Date.now(),
      stopping: false,
      protocolErrors: 0,
      restartTimes: [],
      readyResolve: null,
      readyReject: null,
      interruptedMessageId: null,
      hardKillTimer: null,
    };
    // Önceki çökme sayacını taşı.
    handle.restartTimes = this.previousRestarts.get(this.key(roomId, agentName)) ?? [];
    this.handles.set(this.key(roomId, agentName), handle);

    const ready = new Promise<void>((resolve, reject) => {
      handle.readyResolve = resolve;
      handle.readyReject = reject;
    });

    exec.onLine((line) => this.enqueue(handle, line));
    exec.onStderr((text) => this.opts.log("info", `[${agentName}] ${text.trimEnd()}`));
    exec.onExit((code) => this.enqueueExit(handle, code));

    const timer = setTimeout(() => {
      handle.readyReject?.(new Error("runner 30 sn içinde hazır olmadı"));
    }, this.opts.readyTimeoutMs);

    try {
      await ready;
      return "idle";
    } catch (err) {
      if (handle.pid) await exec.hardKill(handle.pid).catch(() => undefined);
      throw err;
    } finally {
      clearTimeout(timer);
      handle.readyResolve = null;
      handle.readyReject = null;
    }
  }

  /** Çökme sayacı handle silinince kaybolmasın. */
  private readonly previousRestarts = new Map<string, number[]>();

  // --- diff tabanı --------------------------------------------------------

  /**
   * Agent'ın canlı diff tabanını hazırla.
   *
   * Taban zaten varsa ağacını checkpoint kaydından okur; yoksa container
   * içinde `gitkit init-workspace` çalıştırır, `checkpoint.created`
   * (`kind: "baseline"`) yazar ve `agent_runtime`'a işler.
   *
   * `null` dönmesi "diff yok" demektir, "agent başlamasın" demek değil.
   */
  private async ensureDiffBase(
    roomId: string,
    agentName: string,
    container: string,
    workspace: string,
    sessionId: string,
  ): Promise<{ checkpointId: string; treeSha: string } | null> {
    const workdir = `/room/${workspace}`;
    try {
      const rt = await getRuntime(roomId, agentName, this.pool);
      if (rt?.diffBaseCheckpointId) {
        const cp = await getCheckpoint(roomId, rt.diffBaseCheckpointId, this.pool);
        // Kayıt varsa ağacı oradan gelir; yoksa (elle silinmiş DB, eski oda)
        // taban yeniden alınır — yarım bir tabanla diff göstermek yanlış.
        if (cp) return { checkpointId: cp.checkpointId, treeSha: cp.treeSha };
        this.opts.log("warn", `taban checkpoint kaydı yok (${rt.diffBaseCheckpointId}), yeniden alınıyor`);
      }

      const init = await gitkitInitWorkspace(container, workdir);
      await recordCheckpoint(
        {
          roomId,
          sessionId,
          actor: { kind: "system" },
          type: "checkpoint.created",
          payload: {
            agent: agentName,
            checkpointId: init.checkpointId,
            kind: "baseline",
            label: "taban",
            commitSha: init.commitSha,
            treeSha: init.treeSha,
            messageId: null,
            by: null,
            becomesBase: true,
          },
        } satisfies NewRoomEvent,
        this.pool,
      );
      this.opts.log(
        "info",
        `diff tabanı alındı (${agentName}): ${init.checkpointId}${init.created ? " — workspace depoya çevrildi" : ""}`,
      );
      return { checkpointId: init.checkpointId, treeSha: init.treeSha };
    } catch (err) {
      const why = err instanceof GitkitError ? err.message : String(err);
      this.opts.log("warn", `diff tabanı alınamadı (${agentName}): ${why} — canlı diff kapalı`);
      return null;
    }
  }

  /**
   * Tabanı değiştir: manuel checkpoint alındıktan sonra çağrılır.
   *
   * Runner ayaktaysa `set_base` gider (yeni tabana göre TAM diff yayımlar);
   * değilse bir sonraki başlangıçta ortam değişkeniyle alır — iki yol da
   * `agent_runtime.diff_base_checkpoint_id`'yi okur, yani tek kaynak.
   */
  setDiffBase(roomId: string, agentName: string, base: { checkpointId: string; treeSha: string }): void {
    const handle = this.handles.get(this.key(roomId, agentName));
    if (!handle) return;
    handle.exec.send({ kind: "set_base", ...base });
  }

  /** Runner ayakta mı — API "agent boşta mı" sorusunu runtime'dan sorar, bu ondan ayrı. */
  isRunning(roomId: string, agentName: string): boolean {
    return this.handles.has(this.key(roomId, agentName));
  }

  // --- satır işleme -------------------------------------------------------

  private enqueue(handle: AgentHandle, line: string): void {
    handle.chain = handle.chain
      .then(() => this.handleLine(handle, line))
      .catch((err) => this.opts.log("error", `runner satırı işlenemedi: ${String(err)}`, line));
  }

  private enqueueExit(handle: AgentHandle, code: number | null): void {
    handle.chain = handle.chain
      .then(() => this.handleExit(handle, code))
      .catch((err) => this.opts.log("error", `çıkış işlenemedi: ${String(err)}`));
  }

  private async handleLine(handle: AgentHandle, line: string): Promise<void> {
    let output: RunnerOutput;
    try {
      output = RunnerOutput.parse(JSON.parse(line)) as RunnerOutput;
    } catch (err) {
      handle.protocolErrors += 1;
      this.opts.log("warn", `protokol hatası (${handle.protocolErrors}): ${String(err)}`, line);
      if (handle.protocolErrors > MAX_PROTOCOL_ERRORS && handle.pid) {
        this.opts.log("error", "çok fazla protokol hatası, runner öldürülüyor");
        await handle.exec.hardKill(handle.pid).catch(() => undefined);
      }
      return; // event log'a ASLA yazılmaz
    }

    // Herhangi bir satır gelmesi runner'ın yaşadığının kanıtıdır. Canlılığı
    // tek bir mesaj tipine bağlamak kırılgan: heartbeat'i kaçıran ama iş
    // üreten bir runner boşuna öldürülürdü.
    handle.lastHeartbeat = Date.now();

    switch (output.kind) {
      case "ready": {
        handle.pid = output.pid;
        // Bayat imaj kontrolü: şema değişip imaj yeniden kurulmazsa runner
        // bilinmeyen alanlara takılıp döngüye girer. Anlaşılmaz çökme yerine
        // ne yapılacağını söyle ve yeniden başlatmayı DENEME.
        if (output.protocolVersion !== PROTOCOL_VERSION) {
          const found = output.protocolVersion ?? "yok (eski imaj)";
          const msg =
            `runner protokol sürümü uyuşmuyor — imaj: ${found}, host: ${PROTOCOL_VERSION}. ` +
            `Oda imajını yeniden derle: npm run room:build`;
          this.opts.log("error", msg);
          handle.stopping = true;
          await forceStopped(handle.roomId, handle.agent.name, msg, this.pool);
          handle.readyReject?.(new Error(msg));
          if (handle.pid) await handle.exec.hardKill(handle.pid).catch(() => undefined);
          return;
        }
        handle.lastHeartbeat = Date.now();
        await transition(handle.roomId, handle.agent.name, "idle", {}, this.pool);
        await this.write(
          handle,
          this.systemEvent(handle, {
            roomId: handle.roomId,
            sessionId: handle.sessionId,
            actor: { kind: "system" },
            type: "agent.ready",
            payload: { agent: handle.agent.name, runnerPid: output.pid },
          }),
        );
        handle.readyResolve?.();
        return;
      }
      case "heartbeat":
        // Bellekte kalır — log'u gürültüyle doldurmaz.
        handle.lastHeartbeat = Date.now();
        return;
      case "event":
        /**
         * `checkpoint.created` AYRI YOLDAN yazılır: event ile `checkpoints`
         * satırı aynı transaction'a girmeli. İkisi ayrı düşerse "hangi
         * taban" sorusunun iki cevabı olur ve hangisinin doğru olduğu
         * bilinemez.
         */
        if (output.event.type === "checkpoint.created") {
          await recordCheckpoint(output.event, this.pool);
          return;
        }
        await appendEvent(output.event, this.pool);
        return;
      case "turn_end": {
        const rt = await getRuntime(handle.roomId, handle.agent.name, this.pool);
        if (rt?.status === "busy") {
          await transition(
            handle.roomId,
            handle.agent.name,
            "idle",
            { sdkSessionId: output.sdkSessionId, currentMessageId: null },
            this.pool,
          );
        }
        // Kesme kapandı: sert kesme sayacı artık gereksiz.
        if (handle.interruptedMessageId === output.messageId) {
          this.clearHardKill(handle);
          handle.interruptedMessageId = null;
        }
        /**
         * Kuyruk akmaya DEVAM EDER — turn başarısız bittiyse de. Başarısız
         * bir turn'ün kuyruğu durdurması, bekleyen herkesi sessizce
         * beklemeye mahkûm ederdi.
         */
        this.notifyFinished(handle.roomId, handle.agent.name, output.messageId);
        return;
      }
      case "log":
        this.opts.log(output.level, `[${handle.agent.name}] ${output.msg}`);
        return;
    }
  }

  // --- mesaj --------------------------------------------------------------

  /**
   * Kuyruktan çıkan mesajı agent'a ver. TEK GİRİŞ KAPISI bu.
   *
   * Hafta 2'deki doğrudan `sendMessage` yolu KALDIRILDI: iki giriş kapısı
   * olsaydı "agent başına tek koşan mesaj" garantisi ikisinin arasında
   * kaybolurdu. Sıralama kuyruğun işi; burası yalnızca teslim eder.
   *
   * `[İsim]: ` önekini KOYAN BURASI. Event log'daki ham metin öneksiz durur:
   * kullanıcının yazdığı şey neyse o.
   */
  async deliverQueued(
    roomId: string,
    agentName: string,
    msg: { messageId: string; text: string; user: { id: string; name: string } },
  ): Promise<void> {
    let rt = await getRuntime(roomId, agentName, this.pool);
    if (!rt) {
      const { config } = await this.resolveAgent(roomId, agentName);
      await ensureRuntimeRows(roomId, config.agents.map((a) => a.name), this.pool);
      rt = await getRuntime(roomId, agentName, this.pool);
    }
    if (!rt) throw new AgentNotFoundError(agentName);

    /**
     * Agent kapalıysa başlat ve `ready` bekle: kuyrukta bekleyen mesaj
     * "agent kapalıydı" diye düşmez, sırası gelince agent ayağa kalkar.
     */
    if (rt.status === "stopped" || rt.status === "failed") {
      await this.start(roomId, agentName);
      rt = await getRuntime(roomId, agentName, this.pool);
    }
    if (rt?.status !== "idle") throw new AgentBusyError(rt?.status ?? "stopped");

    const handle = this.handles.get(this.key(roomId, agentName));
    if (!handle) throw new AgentNotFoundError(`runner ayakta değil: ${agentName}`);

    await appendEvent(
      {
        roomId: handle.roomId,
        sessionId: handle.sessionId,
        /**
         * Actor mesajı YAZAN insan. "Bu turn kimin isteğiyle başladı"
         * sorusunun cevabı kuyruk tablosunda değil event log'unda durmalı;
         * projeksiyon turn'ün sahibini buradan okuyor.
         */
        actor: { kind: "human", id: msg.user.id, name: msg.user.name },
        type: "message.received",
        payload: { agent: agentName, messageId: msg.messageId, text: msg.text },
      } satisfies NewRoomEvent,
      this.pool,
    );
    await transition(roomId, agentName, "busy", { currentMessageId: msg.messageId }, this.pool);

    handle.exec.send({
      kind: "run",
      messageId: msg.messageId,
      text: `[${msg.user.name}]: ${msg.text}`,
    });
  }

  // --- kesme --------------------------------------------------------------

  /**
   * Koşan turn'ü kes. Yetki (yalnızca sürücü) API katmanında kontrol edilir.
   *
   * KESME İKİ AŞAMALI ve arası sıfır değil:
   *   `interrupt.requested` (hemen) → runner'a sinyal → `interrupt.applied`
   *
   * Uzun bir bash komutunun ortasında anlık durdurma sözü verilmiyor. 30 sn
   * sonunda turn hâlâ kapanmadıysa runner SERT kesilir — "kestim" deyip
   * durmamak kullanıcıya yalan söylemektir.
   */
  async requestInterrupt(
    roomId: string,
    agentName: string,
    msg: { messageId: string; by: { id: string; name: string } },
  ): Promise<void> {
    const handle = this.handles.get(this.key(roomId, agentName));
    if (!handle) throw new AgentNotFoundError(`runner ayakta değil: ${agentName}`);

    await appendEvent(
      {
        roomId: handle.roomId,
        sessionId: handle.sessionId,
        actor: { kind: "human", id: msg.by.id, name: msg.by.name },
        type: "interrupt.requested",
        payload: { agent: agentName, messageId: msg.messageId, by: msg.by },
      } satisfies NewRoomEvent,
      this.pool,
    );

    handle.interruptedMessageId = msg.messageId;
    handle.exec.send({ kind: "interrupt", messageId: msg.messageId });

    this.clearHardKill(handle);
    handle.hardKillTimer = setTimeout(() => {
      void this.hardKillAfterInterrupt(roomId, agentName, msg.messageId);
    }, HARD_KILL_AFTER_MS);
    handle.hardKillTimer.unref?.();
  }

  private clearHardKill(handle: AgentHandle): void {
    if (handle.hardKillTimer) clearTimeout(handle.hardKillTimer);
    handle.hardKillTimer = null;
  }

  private async hardKillAfterInterrupt(
    roomId: string,
    agentName: string,
    messageId: string,
  ): Promise<void> {
    const handle = this.handles.get(this.key(roomId, agentName));
    if (!handle || handle.interruptedMessageId !== messageId) return;

    const rt = await getRuntime(roomId, agentName, this.pool);
    if (rt?.status !== "busy" || rt.currentMessageId !== messageId) return;

    this.opts.log("warn", `kesme 30 sn icinde uygulanmadi, runner olduruluyor: ${agentName}`);
    await appendEvent(
      {
        roomId: handle.roomId,
        sessionId: handle.sessionId,
        actor: { kind: "system" },
        type: "interrupt.applied",
        payload: { agent: agentName, messageId, mode: "hard_kill" },
      } satisfies NewRoomEvent,
      this.pool,
    );
    // Çıkış akışı `turn.failed` (reason: interrupted) yazacak ve kuyruk akacak.
    if (handle.pid) await handle.exec.hardKill(handle.pid).catch(() => undefined);
  }

  // --- durdurma ve çökme --------------------------------------------------

  async stop(roomId: string, agentName: string): Promise<void> {
    const handle = this.handles.get(this.key(roomId, agentName));
    if (!handle) {
      await forceStopped(roomId, agentName, null, this.pool);
      return;
    }
    handle.stopping = true;
    handle.exec.send({ kind: "shutdown" });

    await new Promise<void>((resolve) => {
      const done = setTimeout(async () => {
        if (handle.pid) await handle.exec.hardKill(handle.pid).catch(() => undefined);
        resolve();
      }, 5_000);
      handle.exec.onExit(() => {
        clearTimeout(done);
        resolve();
      });
    });
  }

  private async handleExit(handle: AgentHandle, code: number | null): Promise<void> {
    const key = this.key(handle.roomId, handle.agent.name);
    if (!this.handles.has(key)) return; // zaten işlendi
    this.handles.delete(key);
    this.previousRestarts.set(key, handle.restartTimes);

    const rt = await getRuntime(handle.roomId, handle.agent.name, this.pool);
    const wasBusy = rt?.status === "busy";
    const messageId = rt?.currentMessageId ?? null;
    /** Bu çıkış bir kesmenin sonucu mu — sebep "crash" değil "interrupted". */
    const wasInterrupted = messageId !== null && handle.interruptedMessageId === messageId;
    this.clearHardKill(handle);

    if (handle.stopping) {
      if (wasBusy && messageId) {
        await this.write(handle, {
          roomId: handle.roomId,
          sessionId: handle.sessionId,
          actor: { kind: "system" },
          type: "turn.failed",
          payload: {
            agent: handle.agent.name,
            messageId,
            reason: "stopped",
            error: "agent durduruldu",
          },
        } satisfies NewRoomEvent);
      }
      await this.write(
        handle,
        this.systemEvent(handle, {
          roomId: handle.roomId,
          sessionId: handle.sessionId,
          actor: { kind: "system" },
          type: "agent.exited",
          payload: { agent: handle.agent.name, exitCode: code, reason: "stopped" },
        }),
      );
      await transition(
        handle.roomId,
        handle.agent.name,
        "stopped",
        { currentMessageId: null, lastExitCode: code },
        this.pool,
      );
      // Kuyruk satırı kapanmalı: yoksa agent durdurulunca kuyruk sonsuza
      // kadar "koşuyor" der ve sıradaki mesaj hiç başlamaz.
      if (wasBusy && messageId) {
        this.notifyFinished(handle.roomId, handle.agent.name, messageId);
      }
      return;
    }

    // --- beklenmeyen çıkış: çökme akışı ---
    if (wasBusy && messageId) {
      // Mesaj ASLA yeniden gönderilmez.
      await this.write(handle, {
        roomId: handle.roomId,
        sessionId: handle.sessionId,
        actor: { kind: "system" },
        type: "turn.failed",
        payload: {
          agent: handle.agent.name,
          messageId,
          // Sert kesme bir çökme değil: sebep karıştırılırsa "neden durdu"
          // sorusunun cevabı log'da yanlış durur.
          reason: wasInterrupted ? "interrupted" : "crash",
          error: wasInterrupted
            ? `kesme uygulandı (runner öldürüldü, kod ${code})`
            : `runner çıktı (kod ${code})`,
        },
      } satisfies NewRoomEvent);
      handle.interruptedMessageId = null;
      this.notifyFinished(handle.roomId, handle.agent.name, messageId);
    }

    const now = Date.now();
    const recent = handle.restartTimes.filter((t) => now - t < RESTART_WINDOW_MS);
    const willRestart = recent.length < MAX_RESTARTS;
    const restartCount = recent.length + (willRestart ? 1 : 0);

    await this.write(
      handle,
      this.systemEvent(handle, {
        roomId: handle.roomId,
        sessionId: handle.sessionId,
        actor: { kind: "system" },
        type: "agent.crashed",
        payload: {
          agent: handle.agent.name,
          exitCode: code,
          error: `runner beklenmedik şekilde çıktı (kod ${code})`,
          willRestart,
          restartCount,
        },
      }),
    );

    if (!willRestart) {
      await transition(
        handle.roomId,
        handle.agent.name,
        "crashed",
        { currentMessageId: null, lastExitCode: code },
        this.pool,
      );
      await transition(
        handle.roomId,
        handle.agent.name,
        "failed",
        { lastError: "yeniden başlatma hakkı bitti" },
        this.pool,
      );
      /**
       * Agent kurtarılamadı: kuyrukta bekleyen her şey iptal edilir.
       * Sessizce bekleyen bir kuyruk kullanıcıya yalan söyler — "sıradasın"
       * yazan ekran, hiç çalışmayacak bir mesajı gösteriyor olurdu.
       */
      void this.sink
        ?.agentFailed(handle.roomId, handle.agent.name)
        .catch((err) => this.opts.log("error", `kuyruk temizlenemedi: ${String(err)}`));
      return;
    }

    recent.push(now);
    this.previousRestarts.set(key, recent);
    await transition(
      handle.roomId,
      handle.agent.name,
      "crashed",
      { currentMessageId: null, lastExitCode: code, restartCount },
      this.pool,
    );

    const backoff = RESTART_BACKOFF_MS[Math.min(recent.length - 1, RESTART_BACKOFF_MS.length - 1)]!;
    setTimeout(() => {
      void this.start(handle.roomId, handle.agent.name).catch((err) =>
        this.opts.log("error", `yeniden başlatma başarısız: ${String(err)}`),
      );
    }, backoff);
  }

  // --- açılış mutabakatı --------------------------------------------------

  /**
   * Sunucu yeniden başladı: bellekteki handle'lar gitti ama DB "busy" diyor
   * olabilir. Gerçeği DB'ye yaz, container'da sahipsiz runner bırakma.
   */
  async reconcileOnBoot(): Promise<number> {
    const rows = await listUnsettled(this.pool);
    for (const row of rows) {
      const session = await latestSession(row.roomId, this.pool);
      if (session) {
        if (row.status === "busy" && row.currentMessageId) {
          await appendEvent(
            {
              roomId: row.roomId,
              sessionId: session.id,
              actor: { kind: "system" },
              type: "turn.failed",
              payload: {
                agent: row.agentName,
                messageId: row.currentMessageId,
                reason: "crash",
                error: "server restart",
              },
            } satisfies NewRoomEvent,
            this.pool,
          ).catch(() => undefined);
        }
        await appendEvent(
          {
            roomId: row.roomId,
            sessionId: session.id,
            actor: { kind: "system" },
            type: "agent.exited",
            payload: { agent: row.agentName, exitCode: null, reason: "server_restart" },
          } satisfies NewRoomEvent,
          this.pool,
        ).catch(() => undefined);

        const container = session.containerId ?? roomContainerName(row.roomId);
        if ((await containerStatus(container)) === "running") {
          await killStrayRunners(container).catch(() => undefined);
        }
      }
      await forceStopped(row.roomId, row.agentName, "server restart", this.pool);
    }
    return rows.length;
  }

  /** Sunucu kapanırken: tüm runner'lara kibar kapanma. */
  async shutdownAll(): Promise<void> {
    this.stopHealthChecks();
    await Promise.all(
      [...this.handles.values()].map((h) =>
        this.stop(h.roomId, h.agent.name).catch(() => undefined),
      ),
    );
  }
}
