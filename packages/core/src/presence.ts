/**
 * Presence — kim odada, kime bakıyor.
 *
 * BELLEKTE DURUR, EVENT LOG'A YAZILMAZ. "Kim nereye bakıyor" geçici bir
 * bilgidir: kalıcı log'a yazmak, append-only bir dosyayı fare imleci
 * hareketleriyle doldurmak olurdu. Sunucu yeniden başlarsa presence sıfırlanır
 * ve bu doğrudur — bağlantılar da kopmuştur.
 *
 * BAĞLANTI = VARLIK. SSE bağlantısı açılınca kişi odada, kapanınca değil.
 * Ayrı bir "çıkış" mesajına gerek yok; sekmeyi kapatan kimse mesaj gönderemez.
 */

export interface PresencePerson {
  userId: string;
  name: string;
  /** Baktığı agent — sekme değiştirince güncellenir. */
  viewing: string | null;
  /** Odaya giriş anı (epoch ms). Aynı kişinin en ESKİ bağlantısı kazanır. */
  since: number;
}

interface Connection {
  userId: string;
  name: string;
  viewing: string | null;
  since: number;
  /**
   * Son güncelleme SIRASI (duvar saati değil): aynı kullanıcının birden çok
   * sekmesinde hangisi geçerli.
   *
   * `Date.now()` kullanılıyordu ve aynı milisaniyede iki sekme bakış
   * değiştirdiğinde eşitlik çıkıyor, eski sekme kazanıyordu. Sıra sorusunun
   * cevabı artan bir sayaç; milisaniye çözünürlüğü değil.
   */
  touched: number;
}

/** Yayın debounce'u: 250 ms içindeki değişiklikler tek frame'de gider. */
export const PRESENCE_DEBOUNCE_MS = 250;

type Listener = (people: PresencePerson[]) => void;

const rooms = new Map<string, Map<string, Connection>>();
/** Monoton sıra sayacı — `touched` alanının kaynağı. */
let tick = 0;
const touch = (): number => ++tick;
const listeners = new Map<string, Set<Listener>>();
const timers = new Map<string, NodeJS.Timeout>();

function roomMap(roomId: string): Map<string, Connection> {
  let m = rooms.get(roomId);
  if (!m) {
    m = new Map();
    rooms.set(roomId, m);
  }
  return m;
}

/**
 * Odadaki kişiler — KULLANICI başına tek satır.
 *
 * Aynı kişi üç sekme açtıysa UI'da bir kez görünür; `viewing` en son
 * güncellenen bağlantının değeridir (kullanıcının aktif sekmesi odur).
 */
export function listPresence(roomId: string): PresencePerson[] {
  const byUser = new Map<string, { person: PresencePerson; touched: number }>();
  for (const conn of roomMap(roomId).values()) {
    const existing = byUser.get(conn.userId);
    if (!existing) {
      byUser.set(conn.userId, {
        person: { userId: conn.userId, name: conn.name, viewing: conn.viewing, since: conn.since },
        touched: conn.touched,
      });
      continue;
    }
    // Giriş anı: en eski bağlantı. Bakış: en son dokunulan bağlantı.
    existing.person.since = Math.min(existing.person.since, conn.since);
    if (conn.touched > existing.touched) {
      existing.person.viewing = conn.viewing;
      existing.touched = conn.touched;
    }
  }
  return [...byUser.values()].map((v) => v.person).sort((a, b) => a.since - b.since);
}

function notify(roomId: string): void {
  if (timers.has(roomId)) return;
  const timer = setTimeout(() => {
    timers.delete(roomId);
    const people = listPresence(roomId);
    for (const listener of listeners.get(roomId) ?? []) {
      try {
        listener(people);
      } catch {
        // Bir dinleyicinin hatası diğerlerini etkilemesin.
      }
    }
  }, PRESENCE_DEBOUNCE_MS);
  timer.unref?.();
  timers.set(roomId, timer);
}

export function joinPresence(
  roomId: string,
  connectionId: string,
  user: { userId: string; name: string },
): void {
  roomMap(roomId).set(connectionId, {
    userId: user.userId,
    name: user.name,
    viewing: null,
    since: Date.now(),
    touched: touch(),
  });
  notify(roomId);
}

export function leavePresence(roomId: string, connectionId: string): void {
  const m = rooms.get(roomId);
  if (!m?.delete(connectionId)) return;
  if (m.size === 0) rooms.delete(roomId);
  notify(roomId);
}

/**
 * Kullanıcı agent sekmesi değiştirdi.
 *
 * `connectionId` verilirse YALNIZCA o bağlantı güncellenir. Verilmezse
 * kullanıcının tüm bağlantıları güncellenir — eski istemciler için geriye
 * uyumlu yol, ama doğru olan bağlantı bazlı olanı.
 *
 * Neden: bağlantı kimliği yokken üç sekme açan kişi hepsinde aynı agent'a
 * bakıyor görünüyordu; odadaki diğer kişiye "Ayşe backend'e bakıyor" derken
 * Ayşe aslında frontend sekmesindeydi. Bağlantı kimliği ilk SSE frame'inde
 * (`hello`) istemciye gidiyor, istemci onu `POST /presence` gövdesinde geri
 * yolluyor.
 *
 * Başka kullanıcının bağlantı kimliği işe yaramaz: sahiplik kontrol edilir.
 */
export function setViewing(
  roomId: string,
  userId: string,
  viewing: string | null,
  connectionId?: string | null,
): void {
  const m = rooms.get(roomId);
  if (!m) return;
  let changed = false;

  if (connectionId) {
    const conn = m.get(connectionId);
    // Sahiplik kontrolü: kimse başkasının sekmesinin bakışını değiştiremez.
    if (!conn || conn.userId !== userId) return;
    conn.viewing = viewing;
    conn.touched = touch();
    notify(roomId);
    return;
  }

  for (const conn of m.values()) {
    if (conn.userId !== userId) continue;
    conn.viewing = viewing;
    conn.touched = touch();
    changed = true;
  }
  if (changed) notify(roomId);
}

/** Bağlantı hâlâ açık mı ve bu kullanıcıya mı ait. */
export function connectionBelongsTo(
  roomId: string,
  connectionId: string,
  userId: string,
): boolean {
  return rooms.get(roomId)?.get(connectionId)?.userId === userId;
}

export function subscribePresence(roomId: string, listener: Listener): () => void {
  let set = listeners.get(roomId);
  if (!set) {
    set = new Set();
    listeners.set(roomId, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(roomId);
  };
}

/** Test ve kapanış için. */
export function resetPresence(): void {
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  rooms.clear();
  listeners.clear();
}

/** Sağlık ucu için: toplam bağlantı sayısı. */
export function presenceConnectionCount(): number {
  let n = 0;
  for (const m of rooms.values()) n += m.size;
  return n;
}
