import { z } from "zod";
import { RoomEvent } from "./events.js";

/**
 * Sunum düzleminin sözleşmesi — SSE frame'leri ve saklanmış event şekli.
 *
 * Tek gerçek kaynak event log'dur. Buradaki hiçbir şey "sadece UI için"
 * üretilmez; hepsi `session_events`'in bir projeksiyonudur.
 */

/**
 * Log'a yazılmış event. `NewRoomEvent` + sunucunun atadığı `seq` ve `ts`.
 *
 * Görev tanımı buna `createdAt` diyor; bizim zarfımızda alan adı Hafta 1'den
 * beri `ts` ve event kataloğunun tamamı ona bağlı. Anlam aynı, isim farklı.
 */
export const StoredEvent = RoomEvent;
export type StoredEvent = RoomEvent;

/**
 * SSE frame gövdesi: tek frame'de event DİZİSİ.
 *
 * Event başına bir frame yazmak tarayıcıyı boğar; 50 ms tamponlanır ve
 * `id:` alanına frame'deki EN BÜYÜK `seq` yazılır — `Last-Event-ID` ancak
 * böyle doğru çalışır.
 */
export const SSE_EVENT_NAME = "events";

/**
 * Presence frame'i. `id:` ALANI TAŞIMAZ — `id` yalnızca event sırasını
 * ilerletir; presence'a id vermek `Last-Event-ID` imlecini bozar ve yeniden
 * bağlanan istemci event atlar.
 */
export const SSE_PRESENCE_EVENT = "presence";
export const SSE_OVERFLOW_EVENT = "overflow";

/**
 * İlk frame: "sen hangi bağlantısın".
 *
 * Presence bağlantı başına tutulur ama `POST /presence` isteği hangi SSE
 * bağlantısından geldiğini bilmiyordu; sunucu kullanıcının TÜM bağlantılarını
 * güncelliyordu ve üç sekme açan kişi hepsinde aynı agent'a bakıyor
 * görünüyordu. İstemci bu kimliği alır ve bakış bildirirken geri yollar.
 *
 * `id:` ALANI TAŞIMAZ — presence frame'iyle aynı gerekçe.
 */
export const SSE_HELLO_EVENT = "hello";

export const SseHelloPayload = z.object({
  connectionId: z.string().min(1),
  userId: z.string().uuid(),
});
export type SseHelloPayload = z.infer<typeof SseHelloPayload>;

/** Frame başına üst sınır; fazlası sonraki frame'e kalır. */
export const SSE_MAX_EVENTS_PER_FRAME = 200;
/** Tamponlama penceresi — "ham byte akıtma yok" kuralının sunucu tarafı. */
export const SSE_FLUSH_MS = 50;
/** Keep-alive yorum satırı aralığı. */
export const SSE_PING_MS = 15_000;
/** İstemciye yeniden bağlanma gecikmesi önerisi. */
export const SSE_RETRY_MS = 3_000;
/**
 * Yavaş istemci sunucunun belleğini şişirmesin: bekleyen tampon bunu aşarsa
 * `overflow` yazılır ve bağlantı kapatılır; istemci `since` ile geri döner.
 */
export const SSE_MAX_PENDING_BYTES = 5 * 1024 * 1024;

export const SseOverflowPayload = z.object({ lastSeq: z.number().int().nonnegative() });
export type SseOverflowPayload = z.infer<typeof SseOverflowPayload>;

/** `GET /rooms/:id/events` JSON yanıtı (Accept: text/event-stream değilse). */
export const EventsPage = z.object({
  sessionId: z.string().uuid(),
  since: z.number().int().nonnegative(),
  /** Bu sayfadaki en büyük seq — istemci bir sonraki isteğinde bunu `since` yapar. */
  lastSeq: z.number().int().nonnegative(),
  /** true ise istemci sayfalamaya devam eder; false olunca SSE'yi açar. */
  hasMore: z.boolean(),
  events: z.array(StoredEvent),
});
export type EventsPage = z.infer<typeof EventsPage>;
