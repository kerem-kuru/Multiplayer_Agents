import { useEffect, useRef, useState } from "react";
import type { StoredEvent } from "@agent-rooms/protocol";
import { project, type RoomView } from "@agent-rooms/view";
import { fetchEvents, fetchSnapshot, sseUrl, type Person } from "./api.js";

/**
 * Oda akışı: snapshot al → kalan geçmişi sayfala → SSE'ye bağlan → boşluk
 * gördüysen doldur.
 *
 * Snapshot Hafta 4'te eklendi: davet linkiyle giren kişi `since=0`'dan replay
 * YAPMAZ. Snapshot yoksa (veya sürümü eskiyse) sunucu `state: null` döner ve
 * tam replay yolu aynen çalışır.
 *
 * Sunucu boşluğu zaten dolduruyor; buradaki kontrol İSTEMCİ TARAFI GÜVENCE.
 * "seq boşluğu hiçbir zaman sessizce geçilmez" kuralı iki yerde de duruyor.
 *
 * State güncellemesi `requestAnimationFrame` ile toplanır: event başına bir
 * `setState` çağrısı 500 event'lik bir turn'de UI'ı dondurur.
 */

export type Connection = "loading" | "live" | "reconnecting" | "offline";

export interface StreamState {
  view: RoomView;
  connection: Connection;
  lastSeq: number;
  /**
   * Bu SEKMENİN bağlantı kimliği — sunucunun ilk frame'inde (`hello`) gelir.
   * Presence bildirimi bunu geri yollar; yoksa sunucu kullanıcının tüm
   * sekmelerini aynı agent'a bakıyor sanır.
   */
  connectionId: string | null;
  /** Odadakiler — AYRI kanaldan gelir, event log'un parçası değildir. */
  people: Person[];
  reconnect: () => void;
}

const EMPTY: RoomView = { lastSeq: 0, agents: {} };

export function useEventStream(roomId: string | null): StreamState {
  const [view, setView] = useState<RoomView>(EMPTY);
  const [connection, setConnection] = useState<Connection>("loading");
  const [lastSeq, setLastSeq] = useState(0);
  const [people, setPeople] = useState<Person[]>([]);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  /** Snapshot sonrası event'ler seq -> event. Projeksiyon bunun üzerinden. */
  const store = useRef(new Map<number, StoredEvent>());
  /** Snapshot state'i ve kapsadığı son seq — projeksiyonun temeli. */
  const base = useRef<RoomView | undefined>(undefined);
  const baseSeq = useRef(0);
  const frame = useRef<number | null>(null);
  const failures = useRef(0);

  useEffect(() => {
    if (!roomId) return;

    let cancelled = false;
    let source: EventSource | null = null;
    store.current = new Map();
    base.current = undefined;
    baseSeq.current = 0;
    setView(EMPTY);
    setPeople([]);
    setLastSeq(0);
    setConnectionId(null);
    setConnection("loading");

    const flush = (): void => {
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        if (cancelled) return;
        const all = [...store.current.values()];
        setView(project(all, base.current));
        setLastSeq(all.reduce((m, e) => Math.max(m, e.seq), baseSeq.current));
      });
    };

    const absorb = (events: StoredEvent[]): void => {
      let added = false;
      for (const e of events) {
        // İdempotanlık: zaten gördüğümüz seq'i yut.
        if (store.current.has(e.seq)) continue;
        store.current.set(e.seq, e);
        added = true;
      }
      if (added) flush();
    };

    const currentSeq = (): number => {
      // Snapshot'ın kapsadığı aralık da "elimizde" sayılır: SSE `since`'ı ve
      // boşluk kontrolü bunun üzerinden yürür.
      let max = baseSeq.current;
      for (const seq of store.current.keys()) if (seq > max) max = seq;
      return max;
    };

    /** Boşluk doldurma: eksik aralığı REST'ten çek. */
    const fillGap = async (upTo: number): Promise<void> => {
      const from = currentSeq();
      if (upTo <= from + 1) return;
      try {
        const page = await fetchEvents(roomId, from, upTo - from);
        if (!cancelled) absorb(page.events);
      } catch {
        // Sunucu zaten dolduruyor; bu sadece güvence katmanı.
      }
    };

    const connect = (): void => {
      if (cancelled) return;
      source = new EventSource(sseUrl(roomId, currentSeq()));

      source.addEventListener("events", (ev) => {
        if (cancelled) return;
        let batch: StoredEvent[];
        try {
          batch = JSON.parse((ev as MessageEvent<string>).data) as StoredEvent[];
        } catch {
          return;
        }
        failures.current = 0;
        setConnection("live");
        const firstSeq = batch.length > 0 ? Math.min(...batch.map((e) => e.seq)) : 0;
        if (firstSeq > currentSeq() + 1) {
          void fillGap(firstSeq).then(() => absorb(batch));
          return;
        }
        absorb(batch);
      });

      /**
       * Presence frame'i. `id:` taşımadığı için `Last-Event-ID` imlecini
       * ilerletmez — event akışıyla hiç karışmaz.
       */
      source.addEventListener("presence", (ev) => {
        if (cancelled) return;
        try {
          setPeople(JSON.parse((ev as MessageEvent<string>).data) as Person[]);
        } catch {
          // Bozuk frame presence'ı düşürmez, sadece bu güncelleme atlanır.
        }
      });

      /** İlk frame: "sen hangi bağlantısın". `id:` taşımaz, imleci ilerletmez. */
      source.addEventListener("hello", (ev) => {
        if (cancelled) return;
        try {
          const hello = JSON.parse((ev as MessageEvent<string>).data) as { connectionId?: string };
          if (typeof hello.connectionId === "string") setConnectionId(hello.connectionId);
        } catch {
          // Bağlantı kimliği alınamazsa presence kullanıcı bazlı çalışır:
          // eskisi gibi, bozuk değil ama sekme ayrımı olmadan.
        }
      });

      source.addEventListener("overflow", () => {
        // Sunucu bizi yavaş buldu ve kapattı; baştan bağlan.
        source?.close();
        if (!cancelled) connect();
      });

      source.addEventListener("open", () => {
        failures.current = 0;
        setConnection("live");
      });

      source.onerror = () => {
        if (cancelled) return;
        failures.current += 1;
        // EventSource kendi yeniden bağlanmasını yapar; 3 başarısızlıktan
        // sonra kullanıcıya manuel düğme gösterilir.
        setConnection(failures.current >= 3 ? "offline" : "reconnecting");
        if (failures.current >= 3) source?.close();
      };
    };

    /** Önce snapshot, sonra kalan geçmiş, sonra SSE. */
    void (async () => {
      try {
        const snapshot = await fetchSnapshot(roomId);
        if (cancelled) return;
        if (snapshot.state) {
          base.current = snapshot.state;
          baseSeq.current = snapshot.seq;
          setView(snapshot.state);
          setLastSeq(snapshot.seq);
        }
      } catch {
        // Snapshot bir hızlandırmadır; alınamazsa tam replay'e düşeriz.
      }

      let since = baseSeq.current;
      for (;;) {
        try {
          const page = await fetchEvents(roomId, since);
          if (cancelled) return;
          absorb(page.events);
          since = page.lastSeq;
          if (!page.hasMore) break;
        } catch {
          if (cancelled) return;
          setConnection("offline");
          return;
        }
      }
      if (!cancelled) connect();
    })();

    return () => {
      cancelled = true;
      source?.close();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [roomId, nonce]);

  return {
    view,
    connection,
    lastSeq,
    people,
    connectionId,
    reconnect: () => {
      failures.current = 0;
      setNonce((n) => n + 1);
    },
  };
}
