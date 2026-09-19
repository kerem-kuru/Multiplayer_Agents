import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { closePool, getPool } from "../src/db/pool.js";
import {
  DriverPresenceWatcher,
  claimDriver,
  ensureDriverRows,
  getDriver,
  handoffDriver,
  isDriver,
  releaseDriver,
  sweepAbsentDrivers,
} from "../src/driver.js";
import { joinPresence, leavePresence, resetPresence } from "../src/presence.js";
import { setRoomAllowPatterns } from "../src/redaction.js";

/**
 * Sürücü testleri — gerçek DB.
 *
 * Ölçülen üç şey: çifte claim'de ikincisi 409; devirden sonra eski sürücünün
 * yetkisi bitiyor; presence kaybolduktan sonra sürücülük kendiliğinden düşüyor
 * ama presence geri gelirse DÜŞMÜYOR.
 */

const DB = process.env.DATABASE_URL ?? "postgres://rooms:Kk2007..@localhost:5433/agent_rooms";
const AGENT = "backend";

let alive = false;
let roomId = "";
let sessionId = "";
let ayse: { id: string; name: string };
let ali: { id: string; name: string };

const newUser = async (name: string): Promise<{ id: string; name: string }> => {
  const id = randomUUID();
  await getPool().query(`INSERT INTO users (id, email, name) VALUES ($1, $2, $3)`, [
    id,
    `${id}@driver.test`,
    name,
  ]);
  return { id, name };
};

beforeAll(async () => {
  process.env.DATABASE_URL = DB;
  try {
    const probe = new pg.Client({ connectionString: DB, connectionTimeoutMillis: 2000 });
    await probe.connect();
    await probe.end();
    alive = true;
  } catch {
    return;
  }

  const pool = getPool();
  roomId = randomUUID();
  sessionId = randomUUID();
  await pool.query(
    `INSERT INTO rooms (id, name, config, config_digest) VALUES ($1, $2, $3::jsonb, $4)`,
    [roomId, "sürücü testi", JSON.stringify({ version: 1, name: "t", agents: [] }), "2".repeat(64)],
  );
  await pool.query(`INSERT INTO sessions (id, room_id) VALUES ($1, $2)`, [sessionId, roomId]);
  setRoomAllowPatterns(roomId, []);
  ayse = await newUser("Ayse");
  ali = await newUser("Ali");
  await ensureDriverRows(roomId, [AGENT, "frontend"]);
});

afterEach(async () => {
  if (!alive) return;
  resetPresence();
  // Her test temiz başlasın: sürücülüğü boşalt.
  await getPool().query(
    `UPDATE agent_driver SET user_id = NULL, since = NULL WHERE room_id = $1`,
    [roomId],
  );
});

afterAll(async () => {
  if (!alive) return;
  await getPool().query(`DELETE FROM agent_driver WHERE room_id = $1`, [roomId]);
  await closePool();
});

describe.runIf(process.env.SKIP_DB !== "1")("sürücü", () => {
  it("çifte claim: ikincisi 409 ve mevcut sürücüyü söylüyor", async () => {
    if (!alive) return;
    const rec = await claimDriver(roomId, AGENT, ayse);
    expect(rec.user?.id).toBe(ayse.id);

    await expect(claimDriver(roomId, AGENT, ali)).rejects.toMatchObject({
      status: 409,
      // "Yetkin yok" tek başına ne yapacağını anlatmıyor: kimden isteyeceği lazım.
      detail: { currentDriver: { id: ayse.id, name: "Ayse" } },
    });
    expect(await isDriver(roomId, AGENT, ali.id)).toBe(false);
  });

  it("aynı kişi iki kez claim ederse ikinci çağrı event YAZMIYOR", async () => {
    if (!alive) return;
    const before = await eventCount("driver.claimed");
    await claimDriver(roomId, AGENT, ayse);
    await claimDriver(roomId, AGENT, ayse);
    expect(await eventCount("driver.claimed")).toBe(before + 1);
  });

  it("otomatik claim (silent): sürücü varsa sessizce vazgeçiyor", async () => {
    if (!alive) return;
    await claimDriver(roomId, AGENT, ayse);
    // Mesaj göndermek sürücülük kavgası AÇMAMALI.
    const rec = await claimDriver(roomId, AGENT, ali, { silent: true });
    expect(rec.user?.id).toBe(ayse.id);
  });

  it("devirden sonra eski sürücünün yetkisi bitiyor", async () => {
    if (!alive) return;
    const claimed = await claimDriver(roomId, AGENT, ayse);
    const after = await handoffDriver(roomId, AGENT, ayse, ali, claimed.version);

    expect(after.user?.id).toBe(ali.id);
    expect(await isDriver(roomId, AGENT, ali.id)).toBe(true);
    expect(await isDriver(roomId, AGENT, ayse.id)).toBe(false);
    // Eski sürücü artık bırakamaz da: sürücü o değil.
    await expect(releaseDriver(roomId, AGENT, ayse)).rejects.toMatchObject({ status: 403 });
  });

  it("eski version ile devir 409 — sessizce üstüne yazmıyor", async () => {
    if (!alive) return;
    const claimed = await claimDriver(roomId, AGENT, ayse);
    // Araya başka bir değişiklik girdi: version ilerledi.
    await releaseDriver(roomId, AGENT, ayse);
    await claimDriver(roomId, AGENT, ayse);

    await expect(handoffDriver(roomId, AGENT, ayse, ali, claimed.version)).rejects.toMatchObject({
      status: 409,
    });
    expect(await isDriver(roomId, AGENT, ayse.id)).toBe(true);
  });

  it("sürücü olmayan devredemiyor", async () => {
    if (!alive) return;
    const claimed = await claimDriver(roomId, AGENT, ayse);
    await expect(handoffDriver(roomId, AGENT, ali, ayse, claimed.version)).rejects.toMatchObject({
      status: 403,
    });
  });

  it("presence kaybında süre sonunda düşüyor, geri gelirse düşmüyor", async () => {
    if (!alive) return;
    // Gerçekte 60 sn; testte 150 ms. Ölçülen şey süre değil DAVRANIŞ.
    const watcher = new DriverPresenceWatcher({ pool: getPool(), graceMs: 150 });
    try {
      joinPresence(roomId, "c1", { userId: ayse.id, name: "Ayse" });
      await claimDriver(roomId, AGENT, ayse);
      await watcher.check(roomId);

      // Presence duruyor: sayaç bile kurulmamalı.
      await new Promise((r) => setTimeout(r, 250));
      expect(await isDriver(roomId, AGENT, ayse.id)).toBe(true);

      // Sekme kapandı → sayaç kuruldu → ama geri geldi: sayaç sıfırlanır.
      leavePresence(roomId, "c1");
      await watcher.check(roomId);
      joinPresence(roomId, "c2", { userId: ayse.id, name: "Ayse" });
      await watcher.check(roomId);
      await new Promise((r) => setTimeout(r, 250));
      expect(await isDriver(roomId, AGENT, ayse.id)).toBe(true);

      // Şimdi gerçekten gitti.
      leavePresence(roomId, "c2");
      await watcher.check(roomId);
      await new Promise((r) => setTimeout(r, 300));
      expect(await isDriver(roomId, AGENT, ayse.id)).toBe(false);

      const rows = await getPool().query<{ reason: string }>(
        `SELECT payload->>'reason' AS reason FROM session_events
          WHERE session_id = $1 AND type = 'driver.released' ORDER BY seq DESC LIMIT 1`,
        [sessionId],
      );
      expect(rows.rows[0]?.reason).toBe("left_room");
    } finally {
      watcher.stop();
    }
  });

  it("açılış mutabakatı: odada olmayan sürücü bırakılıyor", async () => {
    if (!alive) return;
    await claimDriver(roomId, AGENT, ayse);
    // Presence bellekte ve sunucu yeni kalktı: kimse odada değil.
    const dropped = await sweepAbsentDrivers(getPool());
    expect(dropped).toBeGreaterThanOrEqual(1);
    expect((await getDriver(roomId, AGENT))?.user).toBe(null);
  });
});

async function eventCount(type: string): Promise<number> {
  const res = await getPool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM session_events WHERE session_id = $1 AND type = $2`,
    [sessionId, type],
  );
  return Number(res.rows[0]!.n);
}
