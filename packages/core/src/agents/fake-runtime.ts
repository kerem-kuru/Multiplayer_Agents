import type pg from "pg";
import type { NewRoomEvent } from "@agent-rooms/protocol";
import { appendEvent } from "../db/eventStore.js";
import { getPool } from "../db/pool.js";
import { getRoomConfig, latestSession } from "../room/rooms.js";
import { AgentManager, type TurnSink } from "./manager.js";
import { ensureRuntimeRows, forceStopped, getRuntime, transition } from "./runtime.js";

/**
 * SAHTE KOŞUM ORTAMI — yalnızca kapı testleri ve eşzamanlılık kanıtı için.
 *
 * Neden var: bu haftanın kanıtlaması gereken şey model çıktısı değil
 * SIRALAMA. "İki mesaj asla paralel inference'a girmiyor" iddiasını gerçek
 * agent'la ölçmek pahalı, yavaş ve yarış penceresini daraltıyor. Sahte runner
 * turn'ü N ms sonra bitirir; 5 paralel mesajla yarış penceresi gerçeğinden
 * GENİŞ olur ve kapı 20 kontrolü saniyeler içinde koşar.
 *
 * Ne YAPMAZ: hiçbir modele istek göndermez, hiçbir tool çalıştırmaz. Gerçek
 * agent'ın kanıtlaması gereken şeyler (aktör etiketini modelin okuması, uzun
 * bir bash komutunun ortasında kesilme) AYRI kapıda: `week5-agent-gate.sh`.
 *
 * ÜRETİMDE KURULAMAZ: `NODE_ENV=production` iken constructor hata verir.
 * Sessizce sahte cevap veren bir sunucu, hiç cevap vermeyenden kötüdür.
 */
export interface FakeAgentRuntimeOptions {
  pool?: pg.Pool;
  /** Normal bir turn kaç ms sürer. */
  turnMs?: number;
  /**
   * "Uzun iş" turn'ü kaç ms sürer. Metinde `sleep` geçen mesaj bunu kullanır —
   * kesme kontrolünün kesecek bir şeyi olsun.
   */
  longTurnMs?: number;
  /** Kesme isteğinden ne kadar sonra uygulanır. Sıfır DEĞİL: kesme anlık değil. */
  interruptDelayMs?: number;
  log?: (level: "info" | "warn" | "error", msg: string, extra?: unknown) => void;
}

export class FakeAgentRuntime extends AgentManager {
  private readonly fakePool: pg.Pool;
  private readonly turnMs: number;
  private readonly longTurnMs: number;
  private readonly interruptDelayMs: number;
  private readonly fakeLog: NonNullable<FakeAgentRuntimeOptions["log"]>;
  /** Taban sınıfın `sink`'i özel; sahte ortam kendi kaydını tutuyor. */
  private fakeSink: TurnSink | null = null;
  /** Koşan turn başına zamanlayıcı — kesme onu iptal eder. */
  private readonly inflight = new Map<string, { timer: NodeJS.Timeout; messageId: string }>();

  constructor(opts: FakeAgentRuntimeOptions = {}) {
    super({ apiKey: "", pool: opts.pool });
    if (process.env.NODE_ENV === "production") {
      throw new Error("FakeAgentRuntime üretimde kullanılamaz");
    }
    this.fakePool = opts.pool ?? getPool();
    this.turnMs = opts.turnMs ?? 400;
    this.longTurnMs = opts.longTurnMs ?? 120_000;
    this.interruptDelayMs = opts.interruptDelayMs ?? 1_200;
    this.fakeLog = opts.log ?? (() => undefined);
  }

  override attachSink(sink: TurnSink): void {
    this.fakeSink = sink;
  }

  private fakeKey(roomId: string, agentName: string): string {
    return `${roomId}:${agentName}`;
  }

  private async fakeSessionId(roomId: string): Promise<string> {
    const session = await latestSession(roomId, this.fakePool);
    if (!session) throw new Error(`odanın oturumu yok: ${roomId}`);
    return session.id;
  }

  /** Ad `write` DEĞİL: taban sınıfın aynı adlı özel yöntemiyle çakışıyor. */
  private emit(event: NewRoomEvent): Promise<unknown> {
    return appendEvent(event, this.fakePool);
  }

  override async start(roomId: string, agentName: string) {
    const config = await getRoomConfig(roomId, this.fakePool);
    if (!config) throw new Error(`oda bulunamadı: ${roomId}`);
    await ensureRuntimeRows(
      roomId,
      config.agents.map((a) => a.name),
      this.fakePool,
    );
    const sessionId = await this.fakeSessionId(roomId);
    const rt = await getRuntime(roomId, agentName, this.fakePool);
    if (rt?.status === "idle" || rt?.status === "busy") return rt.status;

    await transition(roomId, agentName, "starting", {}, this.fakePool);
    await this.emit({
      roomId,
      sessionId,
      actor: { kind: "system" },
      type: "agent.starting",
      payload: { agent: agentName, resumeSessionId: null },
    } satisfies NewRoomEvent);
    await transition(roomId, agentName, "idle", {}, this.fakePool);
    await this.emit({
      roomId,
      sessionId,
      actor: { kind: "system" },
      type: "agent.ready",
      payload: { agent: agentName, runnerPid: 0 },
    } satisfies NewRoomEvent);
    return "idle" as const;
  }

  override async stop(roomId: string, agentName: string): Promise<void> {
    const inflight = this.inflight.get(this.fakeKey(roomId, agentName));
    if (inflight) clearTimeout(inflight.timer);
    this.inflight.delete(this.fakeKey(roomId, agentName));
    await forceStopped(roomId, agentName, null, this.fakePool);
    await this.emit({
      roomId,
      sessionId: await this.fakeSessionId(roomId),
      actor: { kind: "system" },
      type: "agent.exited",
      payload: { agent: agentName, exitCode: 0, reason: "stopped" },
    } satisfies NewRoomEvent).catch(() => undefined);
  }

  /**
   * Gerçek manager'ın `deliverQueued`'u ile AYNI event sırası:
   * `message.received` → `turn.started` → `agent.text` → `turn.completed`.
   *
   * Aktör etiketi burada da manager'ın koyduğu önekten okunuyor: sahte agent
   * "kim yazdı" sorusuna `[İsim]: ` önekinden cevap veriyor. Bu, modelin
   * anladığını DEĞİL önekin runner'a ulaştığını kanıtlar.
   */
  override async deliverQueued(
    roomId: string,
    agentName: string,
    msg: { messageId: string; text: string; user: { id: string; name: string } },
  ): Promise<void> {
    const sessionId = await this.fakeSessionId(roomId);
    const rt = await getRuntime(roomId, agentName, this.fakePool);
    if (!rt || rt.status === "stopped" || rt.status === "failed") {
      await this.start(roomId, agentName);
    }

    await this.emit({
      roomId,
      sessionId,
      actor: { kind: "human", id: msg.user.id, name: msg.user.name },
      type: "message.received",
      payload: { agent: agentName, messageId: msg.messageId, text: msg.text },
    } satisfies NewRoomEvent);
    await transition(roomId, agentName, "busy", { currentMessageId: msg.messageId }, this.fakePool);

    const prefixed = `[${msg.user.name}]: ${msg.text}`;
    await this.emit({
      roomId,
      sessionId,
      actor: { kind: "agent", name: agentName },
      type: "turn.started",
      payload: {
        agent: agentName,
        messageId: msg.messageId,
        sdkSessionId: `fake-${agentName}`,
        model: "fake",
        tools: [],
      },
    } satisfies NewRoomEvent);

    // Uzun iş: kesme kontrolünün kesecek bir şeyi olsun.
    const duration = /sleep|uzun/i.test(msg.text) ? this.longTurnMs : this.turnMs;
    const timer = setTimeout(() => {
      void this.finishTurn(roomId, agentName, msg, sessionId, prefixed);
    }, duration);
    timer.unref?.();
    this.inflight.set(this.fakeKey(roomId, agentName), { timer, messageId: msg.messageId });
  }

  private async finishTurn(
    roomId: string,
    agentName: string,
    msg: { messageId: string; text: string; user: { id: string; name: string } },
    sessionId: string,
    prefixed: string,
  ): Promise<void> {
    this.inflight.delete(this.fakeKey(roomId, agentName));
    try {
      // Önekten okunan isim: "sana bu mesajı yazan kimdi" sorusunun cevabı.
      const who = prefixed.match(/^\[([^\]]+)\]/)?.[1] ?? "bilinmiyor";
      await this.emit({
        roomId,
        sessionId,
        actor: { kind: "agent", name: agentName },
        type: "agent.text",
        payload: {
          agent: agentName,
          messageId: msg.messageId,
          text: `${who} yazdı: ${msg.text}`,
        },
      } satisfies NewRoomEvent);
      await this.emit({
        roomId,
        sessionId,
        actor: { kind: "agent", name: agentName },
        type: "turn.completed",
        payload: {
          agent: agentName,
          messageId: msg.messageId,
          subtype: "success",
          numTurns: 1,
          durationMs: this.turnMs,
          costUsd: 0,
          usage: {},
        },
      } satisfies NewRoomEvent);
      const rt = await getRuntime(roomId, agentName, this.fakePool);
      if (rt?.status === "busy") {
        await transition(roomId, agentName, "idle", { currentMessageId: null }, this.fakePool);
      }
    } finally {
      await this.fakeSink?.finishRunning(roomId, agentName, msg.messageId).catch(() => undefined);
    }
  }

  /**
   * Kesme: `interrupt.requested` HEMEN, `interrupt.applied` biraz SONRA.
   *
   * Aradaki gecikme bilerek var — gerçek hayatta uzun bir bash komutunun
   * ortasında agent anında durmuyor ve UI o aralığı "kesme kuyruğa alındı"
   * diye gösteriyor. Sıfır gecikmeli bir sahte, o durumu hiç test etmezdi.
   */
  override async requestInterrupt(
    roomId: string,
    agentName: string,
    msg: { messageId: string; by: { id: string; name: string } },
  ): Promise<void> {
    const sessionId = await this.fakeSessionId(roomId);
    await this.emit({
      roomId,
      sessionId,
      actor: { kind: "human", id: msg.by.id, name: msg.by.name },
      type: "interrupt.requested",
      payload: { agent: agentName, messageId: msg.messageId, by: msg.by },
    } satisfies NewRoomEvent);

    const inflight = this.inflight.get(this.fakeKey(roomId, agentName));
    if (inflight?.messageId === msg.messageId) clearTimeout(inflight.timer);
    this.inflight.delete(this.fakeKey(roomId, agentName));

    const timer = setTimeout(() => {
      void (async () => {
        await this.emit({
          roomId,
          sessionId,
          actor: { kind: "system" },
          type: "interrupt.applied",
          payload: { agent: agentName, messageId: msg.messageId, mode: "abort" },
        } satisfies NewRoomEvent).catch(() => undefined);
        await this.emit({
          roomId,
          sessionId,
          actor: { kind: "system" },
          type: "turn.failed",
          payload: {
            agent: agentName,
            messageId: msg.messageId,
            reason: "interrupted",
            error: "sürücü kesti",
          },
        } satisfies NewRoomEvent).catch(() => undefined);
        const rt = await getRuntime(roomId, agentName, this.fakePool);
        if (rt?.status === "busy") {
          await transition(roomId, agentName, "idle", { currentMessageId: null }, this.fakePool);
        }
        // Kuyruk AKMAYA DEVAM EDER: kesme sonrası sıradaki mesaj başlar.
        await this.fakeSink?.finishRunning(roomId, agentName, msg.messageId).catch(() => undefined);
      })();
    }, this.interruptDelayMs);
    timer.unref?.();
  }

  /**
   * Kapı için: agent'ı `failed` durumuna düşür (gerçekte 3 kez çöküp
   * yeniden başlatma hakkını bitirmek gerekiyor).
   */
  async forceFail(roomId: string, agentName: string, reason: string): Promise<void> {
    const sessionId = await this.fakeSessionId(roomId);
    const inflight = this.inflight.get(this.fakeKey(roomId, agentName));
    if (inflight) clearTimeout(inflight.timer);
    this.inflight.delete(this.fakeKey(roomId, agentName));

    await forceStopped(roomId, agentName, reason, this.fakePool);
    await transition(roomId, agentName, "starting", {}, this.fakePool).catch(() => undefined);
    await transition(roomId, agentName, "failed", { lastError: reason }, this.fakePool).catch(
      () => undefined,
    );
    await this.emit({
      roomId,
      sessionId,
      actor: { kind: "system" },
      type: "agent.crashed",
      payload: {
        agent: agentName,
        exitCode: 137,
        error: reason,
        willRestart: false,
        restartCount: 3,
      },
    } satisfies NewRoomEvent).catch(() => undefined);

    // Sessizce bekleyen bir kuyruk kullanıcıya yalan söyler.
    await this.fakeSink?.agentFailed(roomId, agentName).catch(() => undefined);
    this.fakeLog("warn", `sahte koşum ortamı: ${agentName} failed (${reason})`);
  }

  override startHealthChecks(): void {
    // Sahte runner'da heartbeat yok: izlenecek süreç de yok.
  }

  override stopHealthChecks(): void {}

  override async reconcileOnBoot(): Promise<number> {
    // Gerçek manager'ın yaptığı iş: `busy` kalmış satırları gerçeğe çek.
    return super.reconcileOnBoot();
  }

  override async shutdownAll(): Promise<void> {
    for (const { timer } of this.inflight.values()) clearTimeout(timer);
    this.inflight.clear();
  }
}
