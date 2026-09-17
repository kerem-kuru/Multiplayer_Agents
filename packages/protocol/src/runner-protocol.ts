import { z } from "zod";
import { NewRoomEvent } from "./events.js";

/**
 * Host ↔ runner arasındaki NDJSON protokolü — satır başına bir JSON.
 *
 * Bu "metin kazıma" DEĞİL: her satır bizim tanımladığımız bir şemadır ve Zod
 * ile doğrulanır. Agent'ın ürettiği serbest metin hiçbir zaman parse edilmez;
 * o sadece `agent.text` event'inin payload'ında taşınır.
 *
 * Kurallar:
 * - Runner'ın stdout'una bu şemaya uymayan hiçbir şey yazılamaz. Bu yüzden
 *   runner başlangıcında console.log/info/warn/debug stderr'e yönlendirilir.
 * - Stderr serbesttir; host onu sadece kendi loguna aktarır, event log'a değil.
 * - Stdin kapanırsa (host bağlantısı koptu) runner uçuştaki turn'ü iptal edip
 *   çıkar — container içinde sahipsiz runner kalmasın.
 */

/** Host → runner (stdin) */
export const RunnerCommand = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("run"),
    messageId: z.string().uuid(),
    text: z.string().min(1),
  }),
  z.object({ kind: z.literal("shutdown") }),
]);
export type RunnerCommand = z.infer<typeof RunnerCommand>;

/**
 * Runner → host (stdout)
 *
 * Tip ELDE yazıldı, `z.infer` ile türetilmedi: `NewRoomEvent` şeması
 * `omit()` üzerine bir cast taşıyor ve çıkarsanan tipi `seq`/`ts` içeriyor.
 * Şema çalışma zamanı doğrulaması için doğru, tip için değil.
 */
export const RunnerOutput = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ready"),
    pid: z.number().int(),
    /**
     * Imajdaki runner'ın protokol sürümü. Host'unkiyle uyuşmazsa imaj bayattır
     * ve şema değişiklikleri anlaşılmaz çökme döngüsüne yol açar — bu yüzden
     * el sıkışmada kontrol edilir. Eski imajlarda alan YOKTUR (optional).
     */
    protocolVersion: z.number().int().optional(),
  }),
  /** Sadece bellekte tutulur — event log'a YAZILMAZ, gürültü yapmasın. */
  z.object({ kind: z.literal("heartbeat"), busy: z.boolean() }),
  z.object({ kind: z.literal("event"), event: NewRoomEvent }),
  z.object({
    kind: z.literal("turn_end"),
    messageId: z.string().uuid(),
    sdkSessionId: z.string().nullable(),
    ok: z.boolean(),
  }),
  z.object({
    kind: z.literal("log"),
    level: z.enum(["info", "warn", "error"]),
    msg: z.string(),
  }),
]);
export type RunnerOutput =
  | { kind: "ready"; pid: number; protocolVersion?: number }
  | { kind: "heartbeat"; busy: boolean }
  | { kind: "event"; event: NewRoomEvent }
  | { kind: "turn_end"; messageId: string; sdkSessionId: string | null; ok: boolean }
  | { kind: "log"; level: "info" | "warn" | "error"; msg: string };

/**
 * Runner'ın `docker exec` ile aldığı ortam değişkenleri.
 *
 * `roomId` ve `sessionId` buradan geliyor ki runner tam bir `NewRoomEvent`
 * üretebilsin; host'un satır üstünde zarf doldurması gerekmiyor.
 *
 * ANTHROPIC_API_KEY imaja veya container ayarlarına GÖMÜLMEZ — sadece exec
 * ortamında yaşar, `docker inspect` ile görünmez.
 */
export const RunnerEnv = z.object({
  ROOM_ID: z.string().uuid(),
  SESSION_ID: z.string().uuid(),
  /** Agent'ın YAML config'i, JSON olarak. */
  ROOM_AGENT_CONFIG: z.string().min(1),
  RESUME_SESSION_ID: z.string().optional(),
  /**
   * Doğrudan Anthropic kullanılıyorsa zorunlu. Bedrock/Vertex/gateway
   * seçiliyse kimlik doğrulama dışarıdan gelir (AWS kimlikleri, gcloud ADC)
   * ve bu alan boş kalır.
   */
  ANTHROPIC_API_KEY: z.string().optional(),
  AGENT_MODEL: z.string().min(1),
  AGENT_MAX_TURNS: z.string().optional(),
  AGENT_MAX_BUDGET_USD: z.string().optional(),
});
export type RunnerEnv = z.infer<typeof RunnerEnv>;
