import type pg from "pg";
import type { NewRoomEvent } from "@agent-rooms/protocol";
import { appendEvent } from "./db/eventStore.js";
import { getPool } from "./db/pool.js";
import { getRoomConfig, latestSession } from "./room/rooms.js";
import { listPresence, subscribePresence } from "./presence.js";

/**
 * Sürücülük — agent başına bir rol, bir KİLİT DEĞİL.
 *
 * Sürücü olmayan odayı kullanmaya devam eder: mesaj yazar, kuyruğa girer,
 * kendi kaydını iptal eder. Sürücünün fazladan iki yetkisi var:
 *   1. koşan turn'ü kesmek,
 *   2. başkasının kuyruk kaydını iptal etmek.
 *
 * Bu ayrım bilinçli: "yazma hakkı" ile "yönü değiştirme hakkı" farklı şeyler.
 * Sürücülüğü kilit yapsaydık odaya ikinci kişiyi sokmanın anlamı kalmazdı.
 */

/** Sürücünün presence'ı kaybolduktan ne kadar sonra sürücülük düşer. */
export const DRIVER_GRACE_MS = 60_000;

export interface DriverRecord {
  agentName: string;
  user: { id: string; name: string } | null;
  since: string | null;
  /** Devirde iyimser kilit: istemcinin gördüğü sürüm. */
  version: number;
}

export class DriverError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "DriverError";
  }
}

interface Row {
  agent_name: string;
  user_id: string | null;
  user_name: string | null;
  since: Date | null;
  version: number;
}

const toRecord = (r: Row): DriverRecord => ({
  agentName: r.agent_name,
  user: r.user_id ? { id: r.user_id, name: r.user_name ?? "" } : null,
  since: r.since?.toISOString() ?? null,
  version: r.version,
});

const COLS = `d.agent_name, d.user_id, u.name AS user_name, d.since, d.version`;
const FROM = `agent_driver d LEFT JOIN users u ON u.id = d.user_id`;

async function sessionIdOf(roomId: string, pool: pg.Pool): Promise<string> {
  const session = await latestSession(roomId, pool);
  if (!session) throw new DriverError(404, `odanın oturumu yok: ${roomId}`);
  return session.id;
}

/**
 * Oda açılırken her agent için `user_id = NULL` satır.
 *
 * Satırın önceden var olması şart: `claim` bir UPDATE, INSERT değil. Böylece
 * iki kişi aynı anda sürücülüğü alamaz — satır kilidi ikinciyi bekletir ve o
 * `409` görür.
 */
export async function ensureDriverRows(
  roomId: string,
  agentNames: string[],
  pool: pg.Pool = getPool(),
): Promise<void> {
  if (agentNames.length === 0) return;
  await pool.query(
    `INSERT INTO agent_driver (room_id, agent_name)
     SELECT $1, unnest($2::text[])
     ON CONFLICT (room_id, agent_name) DO NOTHING`,
    [roomId, agentNames],
  );
}

export async function listDrivers(
  roomId: string,
  pool: pg.Pool = getPool(),
): Promise<DriverRecord[]> {
  const res = await pool.query<Row>(
    `SELECT ${COLS} FROM ${FROM} WHERE d.room_id = $1 ORDER BY d.agent_name`,
    [roomId],
  );
  return res.rows.map(toRecord);
}

export async function getDriver(
  roomId: string,
  agentName: string,
  pool: pg.Pool = getPool(),
): Promise<DriverRecord | null> {
  const res = await pool.query<Row>(
    `SELECT ${COLS} FROM ${FROM} WHERE d.room_id = $1 AND d.agent_name = $2`,
    [roomId, agentName],
  );
  const row = res.rows[0];
  if (row) return toRecord(row);
  // Satır yoksa kendini onar (aşağıdaki gerekçe).
  return (await healDriverRow(roomId, agentName, pool))
    ? getDriver(roomId, agentName, pool)
    : null;
}

/**
 * Satırı olmayan bir agent için sürücü satırını SONRADAN yaz.
 *
 * Neden gerekiyor: sürücü satırları Hafta 5'te geldi ve daha önce açılmış
 * odalarda yoktu. Migration 005 mevcut odaları dolduruyor, ama migration'ı
 * koşturmayı unutan bir kurulumda sürücü uçları `404` dönüyor ve ekranda
 * "agent bulunamadı" yazıyor — oysa agent orada. Eksik bir PROJEKSİYON
 * satırını tamir etmek, kullanıcıya olmayan bir sorun göstermekten iyidir.
 *
 * YAML'da olmayan bir agent adı için satır yazılmaz: 404 o durumda doğru
 * cevap.
 */
async function healDriverRow(
  roomId: string,
  agentName: string,
  pool: pg.Pool,
): Promise<boolean> {
  const config = await getRoomConfig(roomId, pool).catch(() => null);
  if (!config?.agents.some((a) => a.name === agentName)) return false;
  await ensureDriverRows(
    roomId,
    config.agents.map((a) => a.name),
    pool,
  );
  return true;
}

export async function isDriver(
  roomId: string,
  agentName: string,
  userId: string,
  pool: pg.Pool = getPool(),
): Promise<boolean> {
  const res = await pool.query<{ user_id: string | null }>(
    `SELECT user_id FROM agent_driver WHERE room_id = $1 AND agent_name = $2`,
    [roomId, agentName],
  );
  return res.rows[0]?.user_id === userId;
}

/**
 * Sürücülüğü al. Sürücü varsa `409` + mevcut sürücü bilgisi.
 *
 * `silent`: otomatik alma (odaya ilk mesajı yazan kişi sürücü boşsa sürücü
 * olur). Zaten sürücü varsa sessizce vazgeçer — mesaj göndermek sürücülük
 * kavgası açmamalı.
 */
export async function claimDriver(
  roomId: string,
  agentName: string,
  user: { id: string; name: string },
  opts: { silent?: boolean } = {},
  pool: pg.Pool = getPool(),
): Promise<DriverRecord> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query<{ user_id: string | null; version: number }>(
      `SELECT user_id, version FROM agent_driver
        WHERE room_id = $1 AND agent_name = $2 FOR UPDATE`,
      [roomId, agentName],
    );
    const row = cur.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      // Eksik satırı tamir edip BİR kez yeniden dene; hâlâ yoksa agent gerçekten yok.
      if (await healDriverRow(roomId, agentName, pool)) {
        return claimDriver(roomId, agentName, user, opts, pool);
      }
      throw new DriverError(404, `agent bulunamadı: ${agentName}`);
    }

    if (row.user_id && row.user_id !== user.id) {
      await client.query("ROLLBACK");
      const current = await getDriver(roomId, agentName, pool);
      if (opts.silent) return current!;
      throw new DriverError(409, "bu agent'ın sürücüsü var", { currentDriver: current?.user });
    }

    // Zaten sürücüysen event yazma: aynı durumu iki kez log'a yazmak gürültü.
    const already = row.user_id === user.id;
    if (!already) {
      await client.query(
        `UPDATE agent_driver SET user_id = $3, since = now(), version = version + 1
          WHERE room_id = $1 AND agent_name = $2`,
        [roomId, agentName, user.id],
      );
    }
    await client.query("COMMIT");

    if (!already) {
      await appendEvent(
        {
          roomId,
          sessionId: await sessionIdOf(roomId, pool),
          actor: { kind: "human", id: user.id, name: user.name },
          type: "driver.claimed",
          payload: { agent: agentName, user },
        } satisfies NewRoomEvent,
        pool,
      );
    }
    return (await getDriver(roomId, agentName, pool))!;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Sürücülüğü bırak. Yalnızca mevcut sürücü. */
export async function releaseDriver(
  roomId: string,
  agentName: string,
  user: { id: string; name: string },
  reason: "manual" | "left_room" | "handoff" = "manual",
  pool: pg.Pool = getPool(),
): Promise<DriverRecord> {
  const res = await pool.query(
    `UPDATE agent_driver SET user_id = NULL, since = NULL, version = version + 1
      WHERE room_id = $1 AND agent_name = $2 AND user_id = $3`,
    [roomId, agentName, user.id],
  );
  if (!res.rowCount) throw new DriverError(403, "bu agent'ın sürücüsü değilsin");

  await appendEvent(
    {
      roomId,
      sessionId: await sessionIdOf(roomId, pool),
      // Kendiliğinden düşen sürücülüğü bir insan yapmadı: actor `system`.
      actor:
        reason === "left_room"
          ? { kind: "system" }
          : { kind: "human", id: user.id, name: user.name },
      type: "driver.released",
      payload: { agent: agentName, user, reason },
    } satisfies NewRoomEvent,
    pool,
  );
  return (await getDriver(roomId, agentName, pool))!;
}

/**
 * Devir — İKİ TIK: "Devret" → kişi seç. Üçüncü adım yok.
 *
 * `version` iyimser kilit: istemci gördüğü sürümü yollar, eşleşmezse `409`.
 * Ekranda gördüğü sürücü artık başkası olabilir ve devir sessizce onun
 * üstüne yazmamalı.
 *
 * Hedefin odanın `member`/`owner` üyesi olduğu ÇAĞIRAN KATMANDA doğrulanır
 * (rol bilgisi API katmanında); burada yalnızca sürücülük mantığı var.
 */
export async function handoffDriver(
  roomId: string,
  agentName: string,
  from: { id: string; name: string },
  to: { id: string; name: string },
  version: number,
  pool: pg.Pool = getPool(),
): Promise<DriverRecord> {
  if (from.id === to.id) throw new DriverError(400, "sürücülük zaten sende");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query<{ user_id: string | null; version: number }>(
      `SELECT user_id, version FROM agent_driver
        WHERE room_id = $1 AND agent_name = $2 FOR UPDATE`,
      [roomId, agentName],
    );
    const row = cur.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      throw new DriverError(404, `agent bulunamadı: ${agentName}`);
    }
    if (row.user_id !== from.id) {
      await client.query("ROLLBACK");
      const current = await getDriver(roomId, agentName, pool);
      throw new DriverError(403, "bu agent'ın sürücüsü değilsin", {
        currentDriver: current?.user,
      });
    }
    if (row.version !== version) {
      await client.query("ROLLBACK");
      const current = await getDriver(roomId, agentName, pool);
      throw new DriverError(409, "sürücü kaydı değişmiş — ekranı yenile", { current });
    }

    await client.query(
      `UPDATE agent_driver SET user_id = $3, since = now(), version = version + 1
        WHERE room_id = $1 AND agent_name = $2`,
      [roomId, agentName, to.id],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }

  await appendEvent(
    {
      roomId,
      sessionId: await sessionIdOf(roomId, pool),
      actor: { kind: "human", id: from.id, name: from.name },
      type: "driver.handed_off",
      payload: { agent: agentName, from, to },
    } satisfies NewRoomEvent,
    pool,
  );
  return (await getDriver(roomId, agentName, pool))!;
}

/**
 * Otomatik bırakma: sürücünün presence'ı tamamen kaybolduktan 60 sn sonra
 * sürücülük düşer.
 *
 * Neden gecikme var: sekme yenilemek presence'ı bir an kaybettirir. Anında
 * düşürsek her F5 sürücülüğü elinden alırdı. Presence geri gelirse sayaç
 * SIFIRLANIR.
 *
 * Neden bellekte: presence da bellekte (event log'a yazılmaz). Sunucu yeniden
 * başlarsa presence sıfırlanır ve bu doğrudur — bağlantılar da kopmuştur;
 * o durumda sürücülük DB'de kalır ve `claim` eden ilk kişi 409 görür. Bunun
 * çözümü açılış mutabakatı: `sweepAbsentDrivers` açılışta bir kez koşar.
 */
export class DriverPresenceWatcher {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly unsubscribes = new Map<string, () => void>();
  private readonly pool: pg.Pool;
  private readonly graceMs: number;
  private readonly log: (level: "info" | "warn" | "error", msg: string) => void;

  constructor(opts: {
    pool?: pg.Pool;
    graceMs?: number;
    log?: (level: "info" | "warn" | "error", msg: string) => void;
  } = {}) {
    this.pool = opts.pool ?? getPool();
    this.graceMs = opts.graceMs ?? DRIVER_GRACE_MS;
    this.log = opts.log ?? (() => undefined);
  }

  /** Odayı izlemeye başla. Aynı oda iki kez izlenmez. */
  watch(roomId: string): void {
    if (this.unsubscribes.has(roomId)) return;
    const stop = subscribePresence(roomId, () => void this.check(roomId));
    this.unsubscribes.set(roomId, stop);
    void this.check(roomId);
  }

  /** Sürücüsü odada olmayan agent'lar için sayaç kur; geri geldiyse iptal et. */
  async check(roomId: string): Promise<void> {
    const present = new Set(listPresence(roomId).map((p) => p.userId));
    const drivers = await listDrivers(roomId, this.pool).catch(() => []);

    for (const d of drivers) {
      const key = `${roomId}:${d.agentName}`;
      if (!d.user) {
        this.clear(key);
        continue;
      }
      if (present.has(d.user.id)) {
        // Presence geri geldi: sayaç sıfırlanır.
        this.clear(key);
        continue;
      }
      if (this.timers.has(key)) continue;

      const user = d.user;
      const timer = setTimeout(() => {
        this.timers.delete(key);
        void this.dropIfStillAbsent(roomId, d.agentName, user);
      }, this.graceMs);
      timer.unref?.();
      this.timers.set(key, timer);
    }
  }

  private async dropIfStillAbsent(
    roomId: string,
    agentName: string,
    user: { id: string; name: string },
  ): Promise<void> {
    // Son bir kontrol: 60 sn sonunda geri gelmiş olabilir.
    if (listPresence(roomId).some((p) => p.userId === user.id)) return;
    try {
      await releaseDriver(roomId, agentName, user, "left_room", this.pool);
      this.log("info", `sürücülük düştü (odadan ayrıldı): ${agentName} / ${user.name}`);
    } catch {
      // Bu arada elle bırakılmış veya devredilmiş olabilir: sorun değil.
    }
  }

  private clear(key: string): void {
    const t = this.timers.get(key);
    if (t) clearTimeout(t);
    this.timers.delete(key);
  }

  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const stop of this.unsubscribes.values()) stop();
    this.unsubscribes.clear();
  }
}

/**
 * Tekil izleyici. Sunucuda tek örnek yeter ve presence da bellekte tek
 * yerde duruyor; iki izleyici aynı sürücülüğü iki kez düşürmeye çalışırdı.
 */
let watcher: DriverPresenceWatcher | null = null;

export function getDriverWatcher(opts?: {
  graceMs?: number;
  log?: (level: "info" | "warn" | "error", msg: string) => void;
}): DriverPresenceWatcher {
  watcher ??= new DriverPresenceWatcher(opts);
  return watcher;
}

/** Testler ve kapanış için. */
export function resetDriverWatcher(): void {
  watcher?.stop();
  watcher = null;
}

/**
 * Açılış mutabakatı: presence sıfırlandığı için hiç kimse odada değil, ama
 * DB'de sürücü yazıyor olabilir. Bu satırlar bırakılır — yoksa yeniden
 * bağlanan kullanıcı kendi sürücülüğünü geri alamaz ve `409` görür.
 */
export async function sweepAbsentDrivers(pool: pg.Pool = getPool()): Promise<number> {
  const res = await pool.query<{
    room_id: string;
    agent_name: string;
    user_id: string;
    name: string;
  }>(
    `SELECT d.room_id, d.agent_name, d.user_id, u.name
       FROM agent_driver d JOIN users u ON u.id = d.user_id
      WHERE d.user_id IS NOT NULL`,
  );
  let dropped = 0;
  for (const row of res.rows) {
    if (listPresence(row.room_id).some((p) => p.userId === row.user_id)) continue;
    /**
     * `releaseDriver` üzerinden: sessizce UPDATE atmak DB'yi değiştirip
     * log'u değiştirmemek olurdu ve ekran (projeksiyon) hâlâ eski sürücüyü
     * gösterirdi. Durum değişikliği event log'dan geçer.
     */
    await releaseDriver(
      row.room_id,
      row.agent_name,
      { id: row.user_id, name: row.name },
      "left_room",
      pool,
    ).catch(() => undefined);
    dropped += 1;
  }
  return dropped;
}
