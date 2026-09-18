import { redactValue } from "@agent-rooms/redact";

export type LogLevel = "info" | "warn" | "error";
export type LogFn = (level: LogLevel, msg: string, extra?: unknown) => void;

/**
 * Secret'ı event log'dan temizleyip stdout'a basmak hiçbir şey kazandırmaz.
 *
 * Runner'ın stderr'i de bu yoldan geçiyor (`AgentManager` her satırı `log`
 * ile yazıyor), yani container içinden gelen ham metin de temizleniyor.
 */
export function createRedactingLogger(sink: LogFn): LogFn {
  return (level, msg, extra) => {
    const cleanMsg = redactValue(msg).text;
    if (extra === undefined) {
      sink(level, cleanMsg);
      return;
    }
    const cleanExtra =
      typeof extra === "string" ? redactValue(extra).text : redactValue(safeJson(extra)).text;
    sink(level, cleanMsg, cleanExtra);
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "<serileştirilemedi>";
  }
}
