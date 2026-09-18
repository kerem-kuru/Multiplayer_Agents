import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { appendEvent } from "../src/db/eventStore.js";
import { closePool, getPool } from "../src/db/pool.js";
import { setRoomAllowPatterns } from "../src/redaction.js";

/**
 * TEK GEÇİT testi — gerçek DB'ye yazıp gerçek satıra bakar.
 *
 * Ölçtüğü şey: `appendEvent` ile içinde secret olan bir event yazıldığında
 * veritabanındaki satırda secret YOK, `[redacted:` VAR ve `redaction_findings`
 * dolu — ama orada da ham değer yok.
 *
 * DB yoksa atlanır (kapı testinde zaten gerçek DB var).
 */

const DB = process.env.DATABASE_URL ?? "postgres://rooms:Kk2007..@localhost:5433/agent_rooms";
let alive = false;
let roomId = "";
let sessionId = "";

const SECRET = "sk-ant-api03-TestOnlyFakeKeyAbCdEfGhIjKl";

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
  // Kimlikler uygulamada üretiliyor (tabloda default yok).
  roomId = randomUUID();
  sessionId = randomUUID();
  await pool.query(
    `INSERT INTO rooms (id, name, config, config_digest) VALUES ($1, $2, $3::jsonb, $4)`,
    [roomId, "redaction testi", JSON.stringify({ version: 1, name: "t", agents: [] }), "0".repeat(64)],
  );
  await pool.query(`INSERT INTO sessions (id, room_id) VALUES ($1, $2)`, [sessionId, roomId]);
  setRoomAllowPatterns(roomId, []);
});

afterAll(async () => {
  if (!alive) return;
  // Event satırları SİLİNMEZ: `session_events` append-only ve DELETE'i bir
  // trigger engelliyor (Hafta 1 garantisi). Testin bıraktığı oda geliştirme
  // veritabanında duruyor; bunu "temizleyen" bir yol açmak garantiyi delerdi.
  if (sessionId) {
    await getPool().query(`DELETE FROM redaction_findings WHERE session_id = $1`, [sessionId]);
  }
  await closePool();
});

describe.runIf(process.env.SKIP_DB !== "1")("appendEvent redaction geçidi", () => {
  it("secret DB'ye hiç girmiyor", async () => {
    if (!alive) return;

    const stored = await appendEvent({
      roomId,
      sessionId,
      actor: { kind: "system" },
      type: "tool.result",
      payload: {
        agent: "backend",
        messageId: "11111111-1111-4111-8111-111111111111",
        toolUseId: "call_1",
        isError: false,
        truncated: false,
        output: `cat .env\nANTHROPIC_API_KEY=${SECRET}\nAWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE`,
      },
    });

    const pool = getPool();
    const row = await pool.query<{ payload: unknown }>(
      `SELECT payload FROM session_events WHERE session_id = $1 AND seq = $2`,
      [sessionId, stored.seq],
    );
    const text = JSON.stringify(row.rows[0]!.payload);

    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(text).toContain("[redacted:");
    // Bağlam kayboluyorsa çıktı okunmaz olur: anahtar adı kalmalı.
    expect(text).toContain("ANTHROPIC_API_KEY=");

    // Yayına giden (SSE'ye düşen) event de temiz olmalı.
    expect(JSON.stringify(stored.payload)).not.toContain(SECRET);

    const findings = await pool.query<{ rule: string; path: string; hash8: string }>(
      `SELECT rule, path, hash8, length FROM redaction_findings WHERE session_id = $1 AND seq = $2`,
      [sessionId, stored.seq],
    );
    expect(findings.rowCount).toBeGreaterThanOrEqual(2);
    const dump = JSON.stringify(findings.rows);
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(findings.rows.every((r) => r.path === "output")).toBe(true);
  });

  it("temiz event bulgu üretmiyor", async () => {
    if (!alive) return;

    const stored = await appendEvent({
      roomId,
      sessionId,
      actor: { kind: "system" },
      type: "debug.note",
      payload: { text: "randevu oluşturuldu, 3 satır değişti" },
    });

    const findings = await getPool().query(
      `SELECT 1 FROM redaction_findings WHERE session_id = $1 AND seq = $2`,
      [sessionId, stored.seq],
    );
    expect(findings.rowCount).toBe(0);
  });
});
