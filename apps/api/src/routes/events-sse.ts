import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { StoredEvent } from "@agent-rooms/protocol";
import {
  SSE_EVENT_NAME,
  SSE_FLUSH_MS,
  SSE_MAX_EVENTS_PER_FRAME,
  SSE_MAX_PENDING_BYTES,
  SSE_OVERFLOW_EVENT,
  SSE_PING_MS,
  SSE_RETRY_MS,
} from "@agent-rooms/protocol";
import { getEventBus, readEvents } from "@agent-rooms/core";

/**
 * Oturumun event akışı — SSE.
 *
 * SIRA PAZARLIĞA AÇIK DEĞİL:
 *   1. bus'a abone ol, geleni TAMPONLA (henüz hiçbir şey yazma)
 *   2. DB'den since+1..şimdi oku ve yaz
 *   3. tamponu boşalt, seq <= lastSentSeq olanları at
 *   4. canlı moda geç
 *
 * Ters sırada yapılırsa DB okuması ile abonelik arasındaki milisaniyelerde
 * üretilen event'ler hiçbir yere ulaşmaz. Bu haftanın kanıtlaması gereken tek
 * şey "tek event kaybolmuyor" olduğu için bu sıra sabittir.
 */

const DB_PAGE = 500;

interface StreamOptions {
  sessionId: string;
  /** Bu sıradan SONRAKİ event'ler gönderilir. */
  since: number;
}

/**
 * `Last-Event-ID` her zaman `?since=` query'sini EZER — tarayıcı yeniden
 * bağlanırken bu başlığı kendisi gönderir ve gerçeği o bilir.
 */
export function resolveSince(c: Context): number {
  const header = c.req.header("last-event-id");
  if (header !== undefined) {
    const n = Number(header);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  const q = Number(c.req.query("since") ?? 0);
  return Number.isInteger(q) && q >= 0 ? q : 0;
}

export function wantsSse(c: Context): boolean {
  return (c.req.header("accept") ?? "").includes("text/event-stream");
}

const byteLength = (events: StoredEvent[]): number =>
  events.reduce((n, e) => n + JSON.stringify(e).length, 0);

export function streamSession(c: Context, opts: StreamOptions) {
  // no-transform: araya giren proxy'ler akışı sıkıştırıp tamponlamasın.
  c.header("Cache-Control", "no-cache, no-transform");
  c.header("Connection", "keep-alive");
  // nginx ve benzeri ters vekillerde tamponlamayı kapatır.
  c.header("X-Accel-Buffering", "no");

  return streamSSE(c, async (stream) => {
    const bus = getEventBus();
    let lastSentSeq = opts.since;
    let closed = false;

    /** Adım 1: abone ol ve tamponla — henüz yazma. */
    let pending: StoredEvent[] = [];
    const unsubscribe = bus.subscribe(opts.sessionId, (event) => {
      if (closed) return;
      pending.push(event);
    });

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      unsubscribe();
      pending = [];
    };
    stream.onAbort(cleanup);

    const writeFrame = async (events: StoredEvent[]): Promise<void> => {
      if (events.length === 0) return;
      const maxSeq = events[events.length - 1]!.seq;
      // `id` frame'deki EN BÜYÜK seq olmalı; Last-Event-ID ancak böyle çalışır.
      await stream.writeSSE({
        id: String(maxSeq),
        event: SSE_EVENT_NAME,
        data: JSON.stringify(events),
      });
      lastSentSeq = Math.max(lastSentSeq, maxSeq);
    };

    try {
      await stream.writeSSE({ data: "", event: "open" });
      // İstemciye yeniden bağlanma gecikmesi önerisi.
      await stream.write(`retry: ${SSE_RETRY_MS}\n\n`);

      /** Adım 2: geçmişi DB'den sayfalayarak yaz. */
      for (;;) {
        if (closed) return;
        const page = await readEvents(opts.sessionId, {
          since: lastSentSeq,
          limit: DB_PAGE,
        });
        if (page.length === 0) break;
        // Frame başına üst sınır; fazlası sonraki frame'e kalır.
        for (let i = 0; i < page.length; i += SSE_MAX_EVENTS_PER_FRAME) {
          await writeFrame(page.slice(i, i + SSE_MAX_EVENTS_PER_FRAME));
        }
        if (page.length < DB_PAGE) break;
      }

      /** Adım 3: tamponu boşalt — geçmişte zaten gönderilenleri at. */
      const buffered = pending.filter((e) => e.seq > lastSentSeq);
      pending = [];
      if (buffered.length > 0) {
        buffered.sort((a, b) => a.seq - b.seq);
        await writeFrame(buffered);
      }

      /** Adım 4: canlı mod. */
      let lastPing = Date.now();
      while (!closed) {
        await new Promise((r) => setTimeout(r, SSE_FLUSH_MS));
        if (closed) break;

        if (pending.length === 0) {
          if (Date.now() - lastPing >= SSE_PING_MS) {
            await stream.write(": ping\n\n");
            lastPing = Date.now();
          }
          continue;
        }

        // Geri baskı: yavaş istemci sunucunun belleğini şişirmesin.
        if (byteLength(pending) > SSE_MAX_PENDING_BYTES) {
          await stream.writeSSE({
            event: SSE_OVERFLOW_EVENT,
            data: JSON.stringify({ lastSeq: lastSentSeq }),
          });
          cleanup();
          return;
        }

        const batch = pending.filter((e) => e.seq > lastSentSeq).sort((a, b) => a.seq - b.seq);
        pending = [];
        if (batch.length === 0) continue;

        /**
         * Sunucu tarafı boşluk doldurma. İki agent aynı oturuma paralel
         * yazdığında `seq` kilitli sayaçla sırayla verilir ama COMMIT sırası
         * ters dönebilir — yani boşluk normaldir, hata değil.
         */
        if (batch[0]!.seq > lastSentSeq + 1) {
          const missing = await readEvents(opts.sessionId, {
            since: lastSentSeq,
            limit: batch[0]!.seq - lastSentSeq - 1,
          });
          if (missing.length > 0) await writeFrame(missing);
        }

        for (let i = 0; i < batch.length; i += SSE_MAX_EVENTS_PER_FRAME) {
          const slice = batch.slice(i, i + SSE_MAX_EVENTS_PER_FRAME).filter((e) => e.seq > lastSentSeq);
          await writeFrame(slice);
        }
        lastPing = Date.now();
      }
    } finally {
      cleanup();
    }
  });
}
