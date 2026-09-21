import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import type { NewRoomEvent } from "@agent-rooms/protocol";
import { closePool, getPool } from "../src/db/pool.js";
import { getCheckpoint, listCheckpoints, recordCheckpoint } from "../src/diff.js";
import { setRoomAllowPatterns } from "../src/redaction.js";
import { ensureRuntimeRows, getRuntime } from "../src/agents/runtime.js";

/**
 * GERÇEK DB. Ölçülen şey: `checkpoint.created` event'i ile `checkpoints`
 * satırı ve `agent_runtime.diff_base_checkpoint_id` AYNI transaction'da mı
 * yazılıyor.
 *
 * Ayrı yazılsalardı "hangi taban" sorusunun iki cevabı olurdu ve hangisinin
 * doğru olduğu bilinemezdi — diff sessizce yanlış bir ağaca göre çizilirdi.
 *
 * DB yoksa atlanır.
 */

const DB = process.env.DATABASE_URL ?? "postgres://rooms:Kk2007..@localhost:5433/agent_rooms";
const AGENT = "backend";

let alive = false;
let roomId = "";
let sessionId = "";
let userId = "";

const cp = (
  over: Partial<{
    checkpointId: string;
    kind: "baseline" | "manual" | "turn";
    label: string;
    messageId: string | null;
    by: { id: string; name: string } | null;
    becomesBase: boolean;
  }> = {},
): Extract<NewRoomEvent, { type: "checkpoint.created" }> => ({
  roomId,
  sessionId,
  actor: { kind: "system" },
  type: "checkpoint.created",
  payload: {
    agent: AGENT,
    checkpointId: over.checkpointId ?? `cp_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    kind: over.kind ?? "baseline",
    label: over.label ?? "taban",
    commitSha: "a".repeat(40),
    treeSha: "b".repeat(40),
    messageId: over.messageId ?? null,
    by: over.by ?? null,
    becomesBase: over.becomesBase ?? true,
  },
});

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
  userId = randomUUID();
  await pool.query(
    `INSERT INTO rooms (id, name, config, config_digest) VALUES ($1, $2, $3::jsonb, $4)`,
    [roomId, "checkpoint testi", JSON.stringify({ version: 1, name: "t", agents: [] }), "0".repeat(64)],
  );
  await pool.query(`INSERT INTO sessions (id, room_id) VALUES ($1, $2)`, [sessionId, roomId]);
  await pool.query(`INSERT INTO users (id, email, name) VALUES ($1, $2, $3)`, [
    userId,
    `${userId}@cp.test`,
    "Ayse",
  ]);
  await ensureRuntimeRows(roomId, [AGENT]);
  setRoomAllowPatterns(roomId, []);
});

afterAll(async () => {
  if (!alive) return;
  const pool = getPool();
  /**
   * Yalnızca GÜNCEL DURUM tabloları siliniyor. `session_events` append-only ve
   * DELETE'i bir trigger engelliyor — oda/oturum satırları da ona FK olduğu
   * için duruyor. Temizlik uğruna log'a dokunmak, log'un tek gerçek kaynak
   * olma iddiasını bozardı.
   */
  await pool.query(`DELETE FROM checkpoints WHERE room_id = $1`, [roomId]);
  await pool.query(`DELETE FROM agent_runtime WHERE room_id = $1`, [roomId]);
  await closePool();
});

describe("recordCheckpoint", () => {
  it("event ve satırı birlikte yazar, tabanı günceller", async () => {
    if (!alive) return;
    const event = cp({ kind: "baseline", becomesBase: true });
    const id = event.payload.checkpointId;

    await recordCheckpoint(event);

    const row = await getCheckpoint(roomId, id);
    expect(row).toMatchObject({ checkpointId: id, kind: "baseline", agentName: AGENT });

    const evs = await getPool().query<{ type: string }>(
      `SELECT type FROM session_events WHERE session_id = $1 ORDER BY seq`,
      [sessionId],
    );
    expect(evs.rows.map((r) => r.type)).toContain("checkpoint.created");

    const rt = await getRuntime(roomId, AGENT);
    expect(rt?.diffBaseCheckpointId).toBe(id);
  });

  it("turn checkpoint'i tabanı KAYDIRMAZ", async () => {
    if (!alive) return;
    const baseBefore = (await getRuntime(roomId, AGENT))?.diffBaseCheckpointId;

    const messageId = randomUUID();
    const event = cp({ kind: "turn", becomesBase: false, messageId, label: "turn sonu" });
    await recordCheckpoint(event);

    const row = await getCheckpoint(roomId, event.payload.checkpointId);
    expect(row).toMatchObject({ kind: "turn", messageId });
    expect((await getRuntime(roomId, AGENT))?.diffBaseCheckpointId).toBe(baseBefore);
  });

  it("manuel checkpoint tabanı kaydırır ve alanı kimin aldığını taşır", async () => {
    if (!alive) return;
    const event = cp({
      kind: "manual",
      becomesBase: true,
      label: "öğle arası",
      by: { id: userId, name: "Ayse" },
    });
    await recordCheckpoint(event);

    const row = await getCheckpoint(roomId, event.payload.checkpointId);
    expect(row).toMatchObject({ kind: "manual", createdBy: userId });
    expect((await getRuntime(roomId, AGENT))?.diffBaseCheckpointId).toBe(event.payload.checkpointId);
  });

  it("aynı checkpoint iki kez yazılırsa satır tekrarlanmaz", async () => {
    if (!alive) return;
    const event = cp({ kind: "manual", becomesBase: false, label: "tekrar" });
    await recordCheckpoint(event);
    await recordCheckpoint(event);

    const res = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM checkpoints WHERE id = $1`,
      [event.payload.checkpointId],
    );
    expect(Number(res.rows[0]!.n)).toBe(1);
  });

  it("liste en yeniden eskiye", async () => {
    if (!alive) return;
    const rows = await listCheckpoints(roomId, AGENT);
    expect(rows.length).toBeGreaterThanOrEqual(4);
    const times = rows.map((r) => Date.parse(r.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });
});
