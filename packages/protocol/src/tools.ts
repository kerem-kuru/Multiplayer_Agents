import { z } from "zod";

/**
 * YAML'daki soyut tool adları → SDK'nın gerçek built-in tool adları.
 *
 * Neden ara katman: rol YAML'ı insanın yazdığı bir dosya. `NotebookEdit`
 * yazmasını beklemek yerine `edit` diyor, eşleme burada yapılıyor. SDK tool
 * adlarını değiştirirse tek dosya güncellenir.
 *
 * Tool yetkisi üç katmanda uygulanır ve hiçbiri sistem prompt'u değildir:
 *   (a) SDK `tools` — agent sadece bunları görür
 *   (b) SDK `disallowedTools` — yasaklılar kaldırılır
 *   (c) `PreToolUse` hook'u — her çağrı YAML'a karşı son kez kontrol edilir
 */

export const ToolName = z.enum(["read", "edit", "bash", "web_fetch", "web_search", "test"]);
export type ToolName = z.infer<typeof ToolName>;

export const TOOL_MAP: Record<ToolName, string[]> = {
  read: ["Read", "Glob", "Grep"],
  edit: ["Edit", "Write", "NotebookEdit"],
  bash: ["Bash"],
  web_fetch: ["WebFetch"],
  web_search: ["WebSearch"],
  // Rezerve: ileride kapsamlı bir Bash kuralına dönüşecek. Şimdilik hiçbir şey açmaz.
  test: [],
};

/** Dosya değiştiren tool'lar — PostToolUse hook'u bunlarda `file.changed` yazar. */
export const FILE_WRITING_TOOLS = ["Edit", "Write", "NotebookEdit"] as const;

export interface ResolvedTools {
  allow: string[];
  deny: string[];
}

/**
 * Subagent tool'u (`Task`/`Agent`) hiçbir eşlemede yer almaz — Hafta 2'de
 * subagent'lar kapalı. Çakışmada deny kazanır.
 */
export function resolveSdkTools(agent: {
  toolsAllow: ToolName[];
  toolsDeny: ToolName[];
}): ResolvedTools {
  const deny = new Set(agent.toolsDeny.flatMap((t) => TOOL_MAP[t]));
  const allow = [...new Set(agent.toolsAllow.flatMap((t) => TOOL_MAP[t]))].filter(
    (t) => !deny.has(t),
  );
  return { allow, deny: [...deny] };
}

/** Event payload'larındaki boyut sınırı — log'u tek bir dev çıktı şişirmesin. */
export const MAX_PAYLOAD_BYTES = 16 * 1024;

export interface Truncated {
  text: string;
  truncated: boolean;
}

export function truncate(value: string, limit = MAX_PAYLOAD_BYTES): Truncated {
  if (Buffer.byteLength(value, "utf8") <= limit) return { text: value, truncated: false };
  // Çok baytlı karakteri ortadan bölmemek için Buffer üzerinden kes.
  const cut = Buffer.from(value, "utf8").subarray(0, limit).toString("utf8");
  return { text: cut, truncated: true };
}

export function truncateJson(value: unknown, limit = MAX_PAYLOAD_BYTES): Truncated {
  let text: string;
  try {
    text = JSON.stringify(value) ?? "null";
  } catch {
    text = '"<serileştirilemedi>"';
  }
  return truncate(text, limit);
}

/** Container içi oda kökü — runner'lar burada koşar. */
export const ROOM_ROOT = "/room";

/**
 * Dosya yollarını oda köküne göre normalleştirir.
 *
 * Koşum ortamları mutlak yol veriyor (`/room/worktrees/backend/hello.js`).
 * Event log'da oda-göreli tutmak iki şeyi sağlar: koşum ortamları aynı biçimi
 * verir, ve UI ile defter host yolundan bağımsız kalır.
 */
export function roomRelativePath(p: string): string {
  const normalized = p.replace(/\\/g, "/");
  if (normalized === ROOM_ROOT) return "";
  const prefix = `${ROOM_ROOT}/`;
  return normalized.startsWith(prefix) ? normalized.slice(prefix.length) : normalized;
}
