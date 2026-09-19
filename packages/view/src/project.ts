import type { StoredEvent } from "@agent-rooms/protocol";

/**
 * Event dizisi → ekranda gösterilebilir model. SAF fonksiyon.
 *
 * Tek gerçek kaynak event log'dur: burada üretilen her şey `session_events`'in
 * bir projeksiyonudur. UI'ın kendi başına tuttuğu durum yoktur.
 *
 * İdempotent: aynı event iki kez verilse sonuç değişmez (`seq` bazlı eleme).
 * Bu, yeniden bağlanmada tekrar gelen event'lerin ekranı bozmamasını sağlar.
 *
 * HEM SUNUCU HEM İSTEMCİ BU FONKSİYONU ÇAĞIRIR: sunucu snapshot üretirken,
 * istemci ekranı çizerken. İkisi ayrı kod olsaydı snapshot ile ekran zamanla
 * birbirinden ayrılırdı ve kimse fark etmezdi.
 *
 * SAF VE DETERMİNİST olmak zorunda: `Date.now()` yok, rastgelelik yok, girdi
 * dışında hiçbir şeye bakmıyor. Snapshot doğruluğu buna dayanıyor —
 * `project(hepsi)` ile `snapshot + sonrası` derin eşit olmalı.
 */

/**
 * Projeksiyon sürümü. Bu dosyadaki üretim mantığı değiştiğinde ARTIRILIR:
 * eski sürümle üretilmiş snapshot'lar okunmaz, tam replay'e düşülür.
 */
export const SNAPSHOT_VERSION = 2;

export type AgentStatus = "stopped" | "starting" | "idle" | "busy" | "crashed" | "failed";

export interface ToolResultView {
  output: string;
  isError: boolean;
  truncated: boolean;
}

export type TurnItem =
  | { kind: "text"; seq: number; text: string }
  | {
      kind: "tool";
      seq: number;
      toolUseId: string;
      tool: string;
      input: unknown;
      truncated: boolean;
      result: ToolResultView | null;
      /** `file.changed` olayları buraya eklenir — kendi toolUseId'si yok. */
      files: string[];
    }
  | { kind: "denied"; seq: number; tool: string; reason: string };

export type TurnOutcome =
  | { kind: "running" }
  | {
      kind: "completed";
      subtype: string;
      numTurns: number;
      durationMs: number;
      costUsd: number;
    }
  | { kind: "failed"; reason: string; error: string };

export interface TurnView {
  messageId: string;
  prompt: string;
  actor: string;
  startedAt: string;
  sdkSessionId: string | null;
  items: TurnItem[];
  outcome: TurnOutcome;
}

/** Kuyrukta bekleyen bir mesaj. Sıra = dizideki sıra (enqueue sırası). */
export interface QueuedMessage {
  messageId: string;
  user: { id: string; name: string };
  text: string;
  queuedAt: string;
}

export interface AgentView {
  status: AgentStatus;
  lastError: string | null;
  /** Eski → yeni. */
  turns: TurnView[];
  /**
   * Bekleyen mesajlar — SUNUCUNUN bildirdiği sıra. İstemci "sıram geldi mi"
   * diye kendi karar vermez; bu diziyi gösterir.
   */
  queue: QueuedMessage[];
  /** Şu an inference'ta olan mesaj. Agent başına en fazla bir tane. */
  running: { messageId: string; user: { id: string; name: string } } | null;
  /** Sürücü — kesme yetkisi olan kişi. null = sürücü yok. */
  driver: { id: string; name: string; since: string } | null;
  /**
   * Kesme istendi ama henüz uygulanmadı. UI bu aralığı "kesme kuyruğa
   * alındı" olarak gösterir; `interrupt.applied` gelince temizlenir.
   */
  interrupt: { requestedBy: { id: string; name: string }; at: string } | null;
}

export interface RoomView {
  lastSeq: number;
  agents: Record<string, AgentView>;
}

const emptyAgent = (): AgentView => ({
  status: "stopped",
  lastError: null,
  turns: [],
  queue: [],
  running: null,
  driver: null,
  interrupt: null,
});

/** Payload'daki kullanıcı nesnesi — Hafta 5 event'lerinde `user` / `by` / `to`. */
const userRef = (value: unknown): { id: string; name: string } | null => {
  if (typeof value !== "object" || value === null) return null;
  const u = value as { id?: unknown; name?: unknown };
  return typeof u.id === "string" && typeof u.name === "string" ? { id: u.id, name: u.name } : null;
};

/** Zarftaki actor insan ise kimliği. `message.received` sahibini buradan alır. */
const humanActor = (actor: unknown): { id: string; name: string } | null => {
  if (typeof actor !== "object" || actor === null) return null;
  const a = actor as { kind?: unknown; id?: unknown; name?: unknown };
  return a.kind === "human" && typeof a.id === "string" && typeof a.name === "string"
    ? { id: a.id, name: a.name }
    : null;
};

const actorLabel = (actor: unknown): string => {
  if (typeof actor !== "object" || actor === null) return "system";
  const a = actor as { kind?: string; name?: string };
  return a.kind === "human" || a.kind === "agent" ? (a.name ?? a.kind) : "system";
};

/**
 * @param base Önceki state (snapshot). Verilirse üzerine uygulanır ve
 *   `base.lastSeq`'ten eski event'ler yutulur. KOPYALANIR, değiştirilmez.
 */
export function project(events: StoredEvent[], base?: RoomView): RoomView {
  const view: RoomView = base
    ? { lastSeq: base.lastSeq, agents: structuredClone(base.agents) }
    : { lastSeq: 0, agents: {} };

  // Tekrarı yut: aynı event iki kez gelirse sonuç değişmemeli.
  const applied = new Set<number>();
  const turnIndex = new Map<string, TurnView>();

  // Snapshot üzerine devam ediyorsak turn dizinini ondan kur: snapshot sonrası
  // gelen `tool.result` kendi turn'ünü bulabilmeli.
  for (const agent of Object.values(view.agents)) {
    for (const turn of agent.turns) turnIndex.set(turn.messageId, turn);
  }

  const agentOf = (name: string): AgentView => {
    let a = view.agents[name];
    if (!a) {
      a = emptyAgent();
      view.agents[name] = a;
    }
    return a;
  };

  const sorted = [...events].sort((a, b) => a.seq - b.seq);

  for (const e of sorted) {
    // Snapshot'ın kapsadığı event'ler tekrar uygulanmaz.
    if (base && e.seq <= base.lastSeq) continue;
    if (applied.has(e.seq)) continue;
    applied.add(e.seq);
    view.lastSeq = Math.max(view.lastSeq, e.seq);

    const payload = e.payload as Record<string, unknown>;
    const agentName = typeof payload.agent === "string" ? payload.agent : null;
    if (!agentName) continue; // oda/oturum event'leri bu görünümün konusu değil

    const agent = agentOf(agentName);
    const messageId = typeof payload.messageId === "string" ? payload.messageId : null;
    const turn = messageId ? turnIndex.get(messageId) : undefined;

    switch (e.type) {
      // --- yaşam döngüsü: sadece durum ---
      case "agent.starting":
        agent.status = "starting";
        break;
      case "agent.ready":
        agent.status = "idle";
        agent.lastError = null;
        break;
      case "agent.exited":
        agent.status = "stopped";
        break;
      case "agent.crashed":
        agent.status = payload.willRestart === true ? "crashed" : "failed";
        agent.lastError = typeof payload.error === "string" ? payload.error : null;
        break;

      // --- kuyruk ---
      case "message.queued": {
        if (!messageId) break;
        const user = userRef(payload.user) ?? humanActor(e.actor);
        if (!user) break;
        // İdempotanlık: aynı event iki kez gelirse kuyrukta iki satır olmaz.
        if (agent.queue.some((q) => q.messageId === messageId)) break;
        agent.queue.push({
          messageId,
          user,
          text: typeof payload.text === "string" ? payload.text : "",
          queuedAt: e.ts,
        });
        break;
      }
      case "message.cancelled":
        // Kuyruktan çıkar. Bu mesaj `message.received` HİÇ almayacak.
        if (messageId) agent.queue = agent.queue.filter((q) => q.messageId !== messageId);
        break;

      // --- sürücü ---
      case "driver.claimed": {
        const user = userRef(payload.user);
        if (user) agent.driver = { ...user, since: e.ts };
        break;
      }
      case "driver.released":
        agent.driver = null;
        break;
      case "driver.handed_off": {
        const to = userRef(payload.to);
        if (to) agent.driver = { ...to, since: e.ts };
        break;
      }

      // --- kesme ---
      case "interrupt.requested": {
        const by = userRef(payload.by);
        if (by) agent.interrupt = { requestedBy: by, at: e.ts };
        break;
      }
      case "interrupt.applied":
        // Uygulandı: "kesme kuyruğa alındı" durumu biter.
        agent.interrupt = null;
        break;

      // --- turn ---
      case "message.received": {
        if (!messageId) break;
        // Kuyruktan çıktı ve koşuyor.
        const queued = agent.queue.find((q) => q.messageId === messageId);
        agent.queue = agent.queue.filter((q) => q.messageId !== messageId);
        const owner = queued?.user ?? humanActor(e.actor);
        agent.running = { messageId, user: owner ?? { id: "", name: actorLabel(e.actor) } };
        const created: TurnView = {
          messageId,
          prompt: typeof payload.text === "string" ? payload.text : "",
          actor: actorLabel(e.actor),
          startedAt: e.ts,
          sdkSessionId: null,
          items: [],
          outcome: { kind: "running" },
        };
        turnIndex.set(messageId, created);
        agent.turns.push(created);
        agent.status = "busy";
        break;
      }
      case "turn.started":
        if (turn) turn.sdkSessionId = typeof payload.sdkSessionId === "string" ? payload.sdkSessionId : null;
        break;
      case "agent.text":
        if (turn) {
          turn.items.push({
            kind: "text",
            seq: e.seq,
            text: typeof payload.text === "string" ? payload.text : "",
          });
        }
        break;
      case "tool.call":
        if (turn) {
          turn.items.push({
            kind: "tool",
            seq: e.seq,
            toolUseId: String(payload.toolUseId ?? ""),
            tool: String(payload.tool ?? "unknown"),
            input: payload.input,
            truncated: payload.truncated === true,
            result: null,
            files: [],
          });
        }
        break;
      case "tool.result": {
        if (!turn) break;
        const id = String(payload.toolUseId ?? "");
        const result: ToolResultView = {
          output: typeof payload.output === "string" ? payload.output : "",
          isError: payload.isError === true,
          truncated: payload.truncated === true,
        };
        const match = [...turn.items]
          .reverse()
          .find((i): i is Extract<TurnItem, { kind: "tool" }> => i.kind === "tool" && i.toolUseId === id);
        if (match) {
          match.result = result;
        } else {
          // Eşleşen çağrı yoksa event DÜŞÜRÜLMEZ; görünür bir yetim olarak durur.
          turn.items.push({
            kind: "tool",
            seq: e.seq,
            toolUseId: id,
            tool: "unknown",
            input: null,
            truncated: false,
            result,
            files: [],
          });
        }
        break;
      }
      case "tool.denied":
        if (turn) {
          turn.items.push({
            kind: "denied",
            seq: e.seq,
            tool: String(payload.tool ?? ""),
            reason: String(payload.reason ?? ""),
          });
        }
        break;
      case "file.changed": {
        if (!turn) break;
        // `file.changed` kendi toolUseId'sini taşımıyor: turn'ün SON tool
        // item'ına eklenir.
        const path = String(payload.path ?? "");
        const last = [...turn.items]
          .reverse()
          .find((i): i is Extract<TurnItem, { kind: "tool" }> => i.kind === "tool");
        if (last && path && !last.files.includes(path)) last.files.push(path);
        break;
      }
      case "turn.completed":
        if (turn) {
          turn.outcome = {
            kind: "completed",
            subtype: String(payload.subtype ?? ""),
            numTurns: Number(payload.numTurns ?? 0),
            durationMs: Number(payload.durationMs ?? 0),
            costUsd: Number(payload.costUsd ?? 0),
          };
        }
        if (agent.status === "busy") agent.status = "idle";
        if (agent.running?.messageId === messageId) agent.running = null;
        break;
      case "turn.failed":
        if (turn) {
          turn.outcome = {
            kind: "failed",
            reason: String(payload.reason ?? ""),
            error: String(payload.error ?? ""),
          };
        }
        if (agent.status === "busy") agent.status = "idle";
        if (agent.running?.messageId === messageId) agent.running = null;
        // Turn kapandıysa bekleyen kesme isteği de biter.
        if (agent.interrupt && agent.running === null) agent.interrupt = null;
        break;

      default:
        // İleride eklenecek event tipleri eski UI'ı ÇÖKERTMEMELİ.
        if (typeof console !== "undefined") console.debug(`bilinmeyen event tipi: ${e.type}`);
        break;
    }
  }

  return view;
}
