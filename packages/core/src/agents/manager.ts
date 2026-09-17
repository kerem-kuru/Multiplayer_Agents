import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { Actor, AgentConfig, NewRoomEvent, RoomConfig } from "@agent-rooms/protocol";
import { PROTOCOL_VERSION, RunnerOutput, collectProviderEnv } from "@agent-rooms/protocol";
import { appendEvent } from "../db/eventStore.js";
import { getPool } from "../db/pool.js";
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
}

export class AgentNotFoundError extends Error {}
export class AgentBusyError extends Error {
  constructor(readonly status: AgentStatus) {
    super(`agent meşgul: ${status}`);
  }
}

const RESTART_WINDOW_MS = 10 * 60 * 1000;
const MAX_RESTARTS = 3;
const RESTART_BACKOFF_MS = [1_000, 4_000, 15_000];
const MAX_PROTOCOL_ERRORS = 10;

export class AgentManager {
  private readonly handles = new Map<string, AgentHandle>();
  private readonly pool: pg.Pool;
  private readonly opts: Required<
    Omit<AgentManagerOptions, "pool" | "modelOverride" | "providerEnv">
  > & { modelOverride?: string; providerEnv: Record<string, string> };
  private healthTimer: NodeJS.Timeout | null = null;

  constructor(options: AgentManagerOptions) {
    this.pool = options.pool ?? getPool();
    this.opts = {
      apiKey: options.apiKey,
      modelOverride: options.modelOverride,
      providerEnv: options.providerEnv ?? collectProviderEnv(process.env),
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
    // Bedrock/Vertex'te anahtar yoktur; boş değişken geçirmek SDK'yı şaşırtır.
    if (this.opts.apiKey) env.ANTHROPIC_API_KEY = this.opts.apiKey;
    if (resumeSessionId) env.RESUME_SESSION_ID = resumeSessionId;

    const exec = await startRunnerExec({
      container,
      workdir: `/room/${agent.workspace}`,
      env,
      user: "agent",
    });

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
        return;
      }
      case "log":
        this.opts.log(output.level, `[${handle.agent.name}] ${output.msg}`);
        return;
    }
  }

  // --- mesaj --------------------------------------------------------------

  async sendMessage(
    roomId: string,
    agentName: string,
    actor: Actor,
    text: string,
  ): Promise<string> {
    let rt = await getRuntime(roomId, agentName, this.pool);
    if (!rt) {
      const { config } = await this.resolveAgent(roomId, agentName);
      await ensureRuntimeRows(roomId, config.agents.map((a) => a.name), this.pool);
      rt = await getRuntime(roomId, agentName, this.pool);
    }
    if (!rt) throw new AgentNotFoundError(agentName);

    if (rt.status === "stopped" || rt.status === "failed") {
      await this.start(roomId, agentName);
      rt = await getRuntime(roomId, agentName, this.pool);
    }
    if (rt?.status !== "idle") throw new AgentBusyError(rt?.status ?? "stopped");

    const handle = this.handles.get(this.key(roomId, agentName));
    if (!handle) throw new AgentNotFoundError(`runner ayakta değil: ${agentName}`);

    const messageId = randomUUID();
    await appendEvent(
      {
        roomId: handle.roomId,
        sessionId: handle.sessionId,
        actor,
        type: "message.received",
        payload: { agent: agentName, messageId, text },
      } satisfies NewRoomEvent,
      this.pool,
    );
    await transition(roomId, agentName, "busy", { currentMessageId: messageId }, this.pool);

    handle.exec.send({ kind: "run", messageId, text });
    return messageId;
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
          reason: "crash",
          error: `runner çıktı (kod ${code})`,
        },
      } satisfies NewRoomEvent);
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
