import type { StoredEvent } from "@agent-rooms/protocol";

/**
 * Event dizisi → ekranda gösterilebilir model. SAF fonksiyon.
 *
 * Tek gerçek kaynak event log'dur: burada üretilen her şey `session_events`'in
 * bir projeksiyonudur. UI'ın kendi başına tuttuğu durum yoktur.
 *
 * İdempotent: aynı event iki kez verilse sonuç değişmez (`seq` bazlı eleme).
 * Bu, yeniden bağlanmada tekrar gelen event'lerin ekranı bozmamasını sağlar.
 */

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

export interface AgentView {
  status: AgentStatus;
  lastError: string | null;
  /** Eski → yeni. */
  turns: TurnView[];
}

export interface RoomView {
  lastSeq: number;
  agents: Record<string, AgentView>;
}

const emptyAgent = (): AgentView => ({ status: "stopped", lastError: null, turns: [] });

const actorLabel = (actor: unknown): string => {
  if (typeof actor !== "object" || actor === null) return "system";
  const a = actor as { kind?: string; name?: string };
  return a.kind === "human" || a.kind === "agent" ? (a.name ?? a.kind) : "system";
};

export function project(events: StoredEvent[]): RoomView {
  const view: RoomView = { lastSeq: 0, agents: {} };
  // Tekrarı yut: aynı event iki kez gelirse sonuç değişmemeli.
  const applied = new Set<number>();
  const turnIndex = new Map<string, TurnView>();

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

      // --- turn ---
      case "message.received": {
        if (!messageId) break;
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
        break;

      default:
        // İleride eklenecek event tipleri eski UI'ı ÇÖKERTMEMELİ.
        if (typeof console !== "undefined") console.debug(`bilinmeyen event tipi: ${e.type}`);
        break;
    }
  }

  return view;
}
