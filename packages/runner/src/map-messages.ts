import type { NewRoomEvent } from "@agent-rooms/protocol";
import { truncate, truncateJson } from "@agent-rooms/protocol";

/**
 * SDK mesajı → event listesi. SAF fonksiyon: SDK'yı import etmez, I/O yapmaz,
 * sadece gelen nesneye bakar. Birim testi bu yüzden mümkün.
 *
 * Kurulu SDK'da `SDKMessage` ~38 üyeli bir birleşim; doküman 4 tanesini
 * anlatıyor. Geri kalan her tip SESSİZCE yok sayılır — bilinmeyen bir mesaj
 * tipi hata değil, sadece bizi ilgilendirmeyen bir olaydır.
 *
 * `parent_tool_use_id` dolu olan mesajlar da yok sayılır: subagent'lar Hafta
 * 2'de kapalı, çıktıları log'a karışmasın.
 */

export interface MapContext {
  roomId: string;
  sessionId: string;
  agent: string;
  messageId: string;
}

export interface MapResult {
  events: NewRoomEvent[];
  /** `system/init` geldiyse SDK oturum kimliği — runner bunu saklar. */
  sdkSessionId?: string;
}

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** tool_result içeriği string de olabilir, blok dizisi de. Metin parçalarını birleştir. */
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content === undefined ? "" : JSON.stringify(content);
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (isRec(block) && block.type === "text") return str(block.text);
      return isRec(block) ? JSON.stringify(block) : String(block);
    })
    .join("");
}

export function mapMessage(msg: unknown, ctx: MapContext): MapResult {
  if (!isRec(msg)) return { events: [] };

  // Subagent çıktısı — Hafta 2'de kapalı.
  if (msg.parent_tool_use_id != null) return { events: [] };

  const envelope = { roomId: ctx.roomId, sessionId: ctx.sessionId };
  const agentActor = { kind: "agent" as const, name: ctx.agent };
  const turn = { agent: ctx.agent, messageId: ctx.messageId };
  const events: NewRoomEvent[] = [];

  switch (msg.type) {
    case "system": {
      if (msg.subtype !== "init") return { events: [] };
      const sdkSessionId = str(msg.session_id);
      events.push({
        ...envelope,
        actor: agentActor,
        type: "turn.started",
        payload: {
          ...turn,
          sdkSessionId,
          model: str(msg.model),
          // SDK'nın GERÇEKTEN açtığı tool listesi. Kapı testi bunu YAML ile karşılaştırır.
          tools: Array.isArray(msg.tools) ? msg.tools.filter((t): t is string => typeof t === "string") : [],
        },
      } as NewRoomEvent);
      return { events, sdkSessionId };
    }

    case "assistant": {
      const blocks = isRec(msg.message) && Array.isArray(msg.message.content) ? msg.message.content : [];
      for (const block of blocks) {
        if (!isRec(block)) continue;
        if (block.type === "text") {
          const text = str(block.text);
          if (text.length === 0) continue;
          events.push({
            ...envelope,
            actor: agentActor,
            type: "agent.text",
            payload: { ...turn, text: truncate(text).text },
          } as NewRoomEvent);
        } else if (block.type === "tool_use") {
          const input = truncateJson(block.input);
          events.push({
            ...envelope,
            actor: agentActor,
            type: "tool.call",
            payload: {
              ...turn,
              toolUseId: str(block.id),
              tool: str(block.name),
              // Kırpıldıysa ham nesne değil, kırpılmış metni taşı.
              input: input.truncated ? input.text : block.input,
              truncated: input.truncated,
            },
          } as NewRoomEvent);
        }
        // thinking blokları bu hafta log'a yazılmaz.
      }
      return { events };
    }

    case "user": {
      const blocks = isRec(msg.message) && Array.isArray(msg.message.content) ? msg.message.content : [];
      for (const block of blocks) {
        if (!isRec(block) || block.type !== "tool_result") continue;
        const output = truncate(contentToText(block.content));
        events.push({
          ...envelope,
          actor: agentActor,
          type: "tool.result",
          payload: {
            ...turn,
            toolUseId: str(block.tool_use_id),
            isError: block.is_error === true,
            output: output.text,
            truncated: output.truncated,
          },
        } as NewRoomEvent);
      }
      return { events };
    }

    case "result": {
      events.push({
        ...envelope,
        actor: agentActor,
        type: "turn.completed",
        payload: {
          ...turn,
          subtype: str(msg.subtype),
          numTurns: num(msg.num_turns),
          durationMs: num(msg.duration_ms),
          costUsd: num(msg.total_cost_usd),
          usage: isRec(msg.usage) ? msg.usage : {},
        },
      } as NewRoomEvent);
      return { events };
    }

    default:
      return { events: [] };
  }
}
