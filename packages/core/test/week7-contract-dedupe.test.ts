import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import type { NewRoomEvent } from "@agent-rooms/protocol";
import { closePool, getPool } from "../src/db/pool.js";
import { appendContractChange } from "../src/db/eventStore.js";
import { setRoomAllowPatterns } from "../src/redaction.js";

/**
 * GERÇEK DB. Ölçülen şey: bir agent'ın yazdığı sözleşmeyi öteki agent'ın
 * izleyicisi aynı içerikle yeniden duyurduğunda log'a İKİNCİ bir
 * `contract.changed` girmiyor mu.
 *
 * 29 Eylül gerçek koşumu: backend `customers.json` yazdı, 32 sn sonra
 * frontend'in izleyicisi aynı sha256'yı `agent: frontend` diye yayımladı ve
 * panel "son yazan: frontend" gösterdi.
 *
 * DB yoksa atlanır.
 */

const DB = process.env.DATABASE_URL ?? "postgres://rooms:Kk2007..@localhost:5433/agent_rooms";

let alive = false;
let roomId = "";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

async function newSession(): Promise<string> {
  const sessionId = randomUUID();
  await getPool().query(`INSERT INTO sessions (id, room_id) VALUES ($1, $2)`, [sessionId, roomId]);
  return sessionId;
}

const change = (
  sessionId: string,
  agent: string,
  sha256: string,
  path = "customers.json",
): Extract<NewRoomEvent, { type: "contract.changed" }> => ({
  roomId,
  sessionId,
  actor: { kind: "agent", name: agent },
  type: "contract.changed",
  payload: { agent, messageId: null, path, sha256, size: 261, deleted: false },
});

async function logged(sessionId: string): Promise<Array<{ agent: string; path: string; sha256: string }>> {
  const res = await getPool().query<{ agent: string; path: string; sha256: string }>(
    `SELECT payload->>'agent' AS agent, payload->>'path' AS path, payload->>'sha256' AS sha256
       FROM session_events
      WHERE session_id = $1 AND type = 'contract.changed'
      ORDER BY seq`,
    [sessionId],
  );
  return res.rows;
}

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
  roomId = randomUUID();
  await getPool().query(
    `INSERT INTO rooms (id, name, config, config_digest) VALUES ($1, $2, $3::jsonb, $4)`,
    [roomId, "sozlesme tekrar testi", JSON.stringify({ version: 1, name: "t", agents: [] }), "0".repeat(64)],
  );
  setRoomAllowPatterns(roomId, []);
});

afterAll(async () => {
  // session_events append-only (DELETE'i trigger engelliyor); oda satırları duruyor.
  if (alive) await closePool();
});

describe("appendContractChange", () => {
  it("öteki agent'ın aynı içerikli yeniden duyurusunu yazmaz", async () => {
    if (!alive) return;
    const s = await newSession();

    expect(await appendContractChange(change(s, "backend", SHA_A))).not.toBeNull();
    expect(await appendContractChange(change(s, "frontend", SHA_A))).toBeNull();

    expect(await logged(s)).toEqual([{ agent: "backend", path: "customers.json", sha256: SHA_A }]);
  });

  it("içerik gerçekten değişince yazar — değiştiren agent'ın adıyla", async () => {
    if (!alive) return;
    const s = await newSession();

    await appendContractChange(change(s, "backend", SHA_A));
    expect(await appendContractChange(change(s, "frontend", SHA_B))).not.toBeNull();
    // Önceki içeriğe dönüş de bir değişiklik: karşılaştırma yalnız SON kayıtla.
    expect(await appendContractChange(change(s, "backend", SHA_A))).not.toBeNull();

    expect((await logged(s)).map((r) => [r.agent, r.sha256])).toEqual([
      ["backend", SHA_A],
      ["frontend", SHA_B],
      ["backend", SHA_A],
    ]);
  });

  it("yollar birbirinden bağımsız", async () => {
    if (!alive) return;
    const s = await newSession();

    await appendContractChange(change(s, "backend", SHA_A, "api.md"));
    expect(await appendContractChange(change(s, "backend", SHA_A, "customers.json"))).not.toBeNull();
    expect(await logged(s)).toHaveLength(2);
  });

  it("aynı anda gelen iki duyurudan yalnız biri yazılır", async () => {
    if (!alive) return;
    const s = await newSession();

    // İki runner aynı dosyayı aynı anda raporlarsa: oturum satırı kilidi
    // olmadan ikisi de "önceki kayıt yok" görür ve ikisi de yazılırdı.
    const results = await Promise.all([
      appendContractChange(change(s, "backend", SHA_A)),
      appendContractChange(change(s, "frontend", SHA_A)),
    ]);

    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(await logged(s)).toHaveLength(1);
  });
});
