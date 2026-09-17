import type { StoredEvent } from "@agent-rooms/protocol";

/**
 * Event yayın kanalı — yazılan event'i canlı dinleyicilere ulaştırır.
 *
 * Arayüz bilerek dar: Faz 2'de süreç içi uygulamanın yerine Redis pub/sub
 * geçecek ve çağıran taraf değişmeyecek. Bu hafta Redis KULLANILMIYOR.
 *
 * Kritik kural `appendEvent` tarafında: publish COMMIT'TEN SONRA yapılır.
 * Önce yayınlamak, UI'da veritabanında olmayan bir event göstermek demektir —
 * ve bu, "tek gerçek kaynak event log'dur" kuralının ihlalidir.
 */
export interface EventBus {
  publish(sessionId: string, event: StoredEvent): void;
  /** Aboneliği iptal eden fonksiyonu döner. */
  subscribe(sessionId: string, cb: (event: StoredEvent) => void): () => void;
  /** Tanılama: şu an kaç açık abone var. Sızıntı testi bunu okur. */
  subscriberCount(sessionId?: string): number;
}

type Listener = (event: StoredEvent) => void;

export class InProcessEventBus implements EventBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(private readonly onError: (err: unknown) => void = () => undefined) {}

  publish(sessionId: string, event: StoredEvent): void {
    const set = this.listeners.get(sessionId);
    if (!set) return;
    // Kopya üzerinde gez: bir dinleyici yayın sırasında abonelikten çıkabilir.
    for (const cb of [...set]) {
      try {
        cb(event);
      } catch (err) {
        // Bir abonenin hatası diğerlerini etkilemez — yoksa tek bozuk
        // bağlantı bütün izleyicileri sessizce düşürür.
        this.onError(err);
      }
    }
  }

  subscribe(sessionId: string, cb: Listener): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(cb);

    let released = false;
    return () => {
      if (released) return; // iki kez çağrılırsa başkasının aboneliğini silme
      released = true;
      const current = this.listeners.get(sessionId);
      if (!current) return;
      current.delete(cb);
      if (current.size === 0) this.listeners.delete(sessionId);
    };
  }

  subscriberCount(sessionId?: string): number {
    if (sessionId) return this.listeners.get(sessionId)?.size ?? 0;
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }
}

/**
 * Süreç genelinde tek bus. `appendEvent` bunu kullanır; testler kendi
 * örneklerini kurabilir.
 */
let shared: EventBus | null = null;

export function getEventBus(): EventBus {
  if (!shared) shared = new InProcessEventBus();
  return shared;
}

/** Testler için: bus'ı değiştir. */
export function setEventBus(bus: EventBus): void {
  shared = bus;
}
