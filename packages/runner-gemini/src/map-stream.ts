import type { NewRoomEvent } from "@agent-rooms/protocol";
import { roomRelativePath, truncate, truncateJson } from "@agent-rooms/protocol";

/**
 * Gemini CLI `-o stream-json` satırı → bizim event kataloğumuz. SAF fonksiyon.
 *
 * Ölçülen akış (docs/runtime-gemini.md):
 *   {"type":"init","session_id":"...","model":"auto"}
 *   {"type":"message","role":"user|assistant","content":"...","delta":true}
 *   {"type":"tool_use","tool_name":"write_file","tool_id":"...","parameters":{...}}
 *   {"type":"tool_result","tool_id":"...","status":"success"}
 *   {"type":"result","status":"success","stats":{...}}
 *
 * Bu "metin kazıma" değil: Gemini'nin kendi yapılandırılmış çıktısını okuyoruz,
 * insan için biçimlenmiş metni değil. Gürültü zaten stderr'e gidiyor.
 */

/** YAML'daki soyut tool adları → Gemini CLI tool adları (bundle'dan çıkarıldı). */
export const GEMINI_TOOL_MAP: Record<string, string[]> = {
  read: ["read_file", "read_many_files", "glob", "list_directory", "grep"],
  edit: ["write_file", "replace"],
  bash: ["run_shell_command"],
  web_fetch: ["web_fetch"],
  web_search: ["google_web_search"],
  test: [],
};

/** Dosya değiştiren tool'lar — `file.changed` bunlardan türetilir. */
const FILE_TOOLS = new Set(["write_file", "replace"]);

/** Subagent tool'u hiçbir zaman açılmaz (Claude tarafında da kapalı). */
export const GEMINI_ALWAYS_DENIED = ["task"];

/**
 * Gemini'nin kendi iç bakım tool'ları: oturum başlığı, yapılacaklar listesi.
 * Dosya veya kabuk işi yapmazlar, YAML yetkisinin konusu değildir — bunları
 * ihlal saymak yanlış pozitif üretir.
 *
 * `save_memory` bu listede DEĞİL: kalıcı veri yazıyor, yetkiye tabidir.
 */
export const GEMINI_INTERNAL_TOOLS = new Set(["update_topic", "write_todos"]);

export function resolveGeminiTools(agent: {
  toolsAllow: string[];
  toolsDeny: string[];
}): { allow: string[]; deny: string[] } {
  const deny = new Set(agent.toolsDeny.flatMap((t) => GEMINI_TOOL_MAP[t] ?? []));
  for (const t of GEMINI_ALWAYS_DENIED) deny.add(t);
  const allow = [...new Set(agent.toolsAllow.flatMap((t) => GEMINI_TOOL_MAP[t] ?? []))].filter(
    (t) => !deny.has(t),
  );
  return { allow, deny: [...deny] };
}

export interface MapContext {
  roomId: string;
  sessionId: string;
  agent: string;
  messageId: string;
  /** Rol YAML'ından çözülmüş izinli Gemini tool adları. */
  allowedTools: ReadonlySet<string>;
}

export interface MapResult {
  events: NewRoomEvent[];
  /** `init` geldiyse Gemini oturum kimliği. */
  sdkSessionId?: string;
  /** `result` geldiyse turn bitti; başarılı mı. */
  finished?: { ok: boolean };
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function mapStreamLine(line: unknown, ctx: MapContext): MapResult {
  if (!isRec(line)) return { events: [] };

  const envelope = { roomId: ctx.roomId, sessionId: ctx.sessionId };
  const actor = { kind: "agent" as const, name: ctx.agent };
  const turn = { agent: ctx.agent, messageId: ctx.messageId };
  const events: NewRoomEvent[] = [];

  switch (line.type) {
    case "init": {
      const sdkSessionId = str(line.session_id);
      events.push({
        ...envelope,
        actor,
        type: "turn.started",
        payload: {
          ...turn,
          sdkSessionId,
          model: str(line.model) || "auto",
          // Gemini init tool listesi VERMİYOR. Boş dizi bir yalan değil:
          // "bilmiyoruz" demek. Yetki kanıtı --allowed-tools tarafında.
          tools: [],
        },
      } as NewRoomEvent);
      return { events, sdkSessionId };
    }

    case "message": {
      // role=user bizim `message.received`'imizin yankısı — host zaten yazdı.
      if (line.role !== "assistant") return { events: [] };
      const text = str(line.content);
      if (text.length === 0) return { events: [] };
      events.push({
        ...envelope,
        actor,
        type: "agent.text",
        payload: { ...turn, text: truncate(text).text },
      } as NewRoomEvent);
      return { events };
    }

    case "tool_use": {
      const tool = str(line.tool_name);
      const toolUseId = str(line.tool_id);

      // Gemini'de tool ÇALIŞMADAN önce araya giremiyoruz (bkz. runner.ts).
      // İzin dışı bir çağrı görürsek bunu SAPTAMA olarak yazarız — engelleme
      // değil. Fark README'de açıkça belirtilmiştir.
      if (!ctx.allowedTools.has(tool) && !GEMINI_INTERNAL_TOOLS.has(tool)) {
        events.push({
          ...envelope,
          actor,
          type: "tool.denied",
          payload: {
            ...turn,
            tool,
            reason: "rol YAML'ında toolsAllow dışında (saptandı, engellenmedi)",
          },
        } as NewRoomEvent);
      }

      const input = truncateJson(line.parameters);
      events.push({
        ...envelope,
        actor,
        type: "tool.call",
        payload: {
          ...turn,
          toolUseId,
          tool,
          input: input.truncated ? input.text : line.parameters,
          truncated: input.truncated,
        },
      } as NewRoomEvent);

      // file.changed'i tool parametrelerinden TÜRET — Gemini'de PostToolUse
      // hook'u kullanmıyoruz, ama yol zaten yapılandırılmış veride duruyor.
      if (FILE_TOOLS.has(tool) && isRec(line.parameters)) {
        const path = line.parameters.file_path ?? line.parameters.path;
        if (typeof path === "string" && path.length > 0) {
          events.push({
            ...envelope,
            actor,
            type: "file.changed",
            payload: { ...turn, path: roomRelativePath(path), tool },
          } as NewRoomEvent);
        }
      }
      return { events };
    }

    case "tool_result": {
      events.push({
        ...envelope,
        actor,
        type: "tool.result",
        payload: {
          ...turn,
          toolUseId: str(line.tool_id),
          isError: str(line.status) !== "success",
          // Gemini tool çıktısının METNİNİ vermiyor, sadece status.
          // Claude'a göre denetim kaybı; docs/runtime-gemini.md'de yazılı.
          output: str(line.status),
          truncated: false,
        },
      } as NewRoomEvent);
      return { events };
    }

    case "result": {
      const stats = isRec(line.stats) ? line.stats : {};
      const ok = str(line.status) === "success";
      events.push({
        ...envelope,
        actor,
        type: "turn.completed",
        payload: {
          ...turn,
          subtype: str(line.status),
          // Gemini turn sayısı vermiyor; bir prompt = bir turn.
          numTurns: 1,
          durationMs: num(stats.duration_ms),
          // USD maliyet YOK, sadece token sayıları. 0 yazmak "bilmiyoruz"
          // demek; fiyat tablosu Hafta 11'de.
          costUsd: 0,
          usage: stats,
        },
      } as NewRoomEvent);
      return { events, finished: { ok } };
    }

    default:
      return { events: [] };
  }
}
