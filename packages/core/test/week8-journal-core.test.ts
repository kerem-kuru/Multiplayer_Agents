import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { applyJournalWrite, EMPTY_JOURNAL, RoomConfig, type JournalState, type NewRoomEvent } from "@agent-rooms/protocol";
import { appendEvent } from "../src/db/eventStore.js";
import { closePool, getPool } from "../src/db/pool.js";
import { readJournalHistory, readJournalState, writeJournalEntry } from "../src/journal.js";
import { setRoomAllowPatterns } from "../src/redaction.js";

/**
 * Hafta 8, Adım 3 — defter çekirdeği. GERÇEK DB.
 *
 * Görev tanımının kabulü: ardışık sürümler 1, 2, 3; paralel iki yazımda
 * ikincisi güncellenmiş hali devralıyor; sürüm tekilliği DB'de; sözleşme
 * birleştirme ve kaldırma. Yeni modelin iddiaları: sicil düşmüyor, sahiplik,
 * host alanları log'dan, redaction tablolara da uygulanıyor, tablolar
 * event'lerin katlanmasına eşit.
 *
 * DB yoksa atlanır.
 */

const DB = process.env.DATABASE_URL ?? "postgres://rooms:Kk2007..@localhost:5433/agent_rooms";
const SECRET = "sk-ant-api03-TestOnlyFakeKeyAbCdEfGhIjKl";
const SHA = "d".repeat(64);

let alive = false;
let roomId = "";
let sessionId = "";

async function freshRoom(): Promise<void> {
  const pool = getPool();
  roomId = randomUUID();
  sessionId = randomUUID();
  await pool.query(`INSERT INTO rooms (id, name, config, config_digest) VALUES ($1, $2, $3::jsonb, $4)`, [
    roomId,
    "defter testi",
    // Üretimdeki gibi şemadan geçmiş hali (varsayılanlar dahil: contractsDir…).
    JSON.stringify(
      RoomConfig.parse({
        version: 1,
        name: "t",
        agents: ["backend", "frontend"].map((name) => ({ name, systemPrompt: "test", workspace: `worktrees/${name}` })),
      }),
    ),
    "0".repeat(64),
  ]);
  await pool.query(`INSERT INTO sessions (id, room_id) VALUES ($1, $2)`, [sessionId, roomId]);
  setRoomAllowPatterns(roomId, []);
}

function write(agent: string, patch: unknown, messageId: string | null = null) {
  return writeJournalEntry({
    roomId,
    agentName: agent,
    messageId,
    source: "agent",
    patch,
    actor: { kind: "agent", name: agent },
  });
}

async function ok(agent: string, patch: unknown, messageId: string | null = null) {
  const r = await write(agent, patch, messageId);
  if (!r.ok) throw new Error(r.message);
  return r;
}

const count = async (sql: string) => Number((await getPool().query(sql, [roomId])).rows[0].n);
const rows = () => count(`SELECT count(*) AS n FROM journal_entries WHERE room_id = $1`);
const written = () =>
  count(`SELECT count(*) AS n FROM session_events WHERE room_id = $1 AND type = 'journal.entry_written'`);

const start = { status: "in_progress", headline: "Auth başladı" };
const decision = { what: "JWT yerine session cookie", why: "frontend SSR gerektiriyor", affects: ["frontend"] };
const login = { name: "POST /api/login", shape: "-> {token, expiresAt}", file: "contracts/auth.md" };

beforeAll(async () => {
  process.env.DATABASE_URL = DB;
  try {
    const probe = new pg.Client({ connectionString: DB, connectionTimeoutMillis: 2000 });
    await probe.connect();
    await probe.end();
    alive = true;
  } catch {
    /* DB yok: testler atlanır */
  }
});

beforeEach(async (ctx) => {
  if (!alive) return ctx.skip();
  await freshRoom();
});

afterAll(async () => {
  if (alive) await closePool();
});

describe("sürümler", () => {
  it("ardışık yazımlar 1, 2, 3", async () => {
    expect((await ok("backend", start)).version).toBe(1);
    expect((await ok("backend", { status: "blocked" })).version).toBe(2);
    expect((await ok("backend", { status: "done" })).version).toBe(3);
    expect((await readJournalHistory(roomId)).map((h) => h.version)).toEqual([1, 2, 3]);
  });

  it("sayaç agent başına", async () => {
    await ok("backend", start);
    await ok("backend", { status: "done" });
    expect((await ok("frontend", start)).version).toBe(1);
  });

  it("paralel iki yazım: ikincisi güncellenmiş hali devralıyor", async () => {
    await ok("backend", start);
    const [a, b] = await Promise.all([
      ok("backend", { headline: "A'nın başlığı" }),
      ok("backend", { task: "b-görevi" }),
    ]);
    expect([a.version, b.version].sort()).toEqual([2, 3]);
    const s = (await readJournalState(roomId)).snapshots.backend!;
    expect(s).toMatchObject({ version: 3, headline: "A'nın başlığı", task: "b-görevi", status: "in_progress" });
  });

  it("aynı (oda, agent, sürüm) ikinci kez: DB reddediyor", async () => {
    await ok("backend", start);
    const dup = getPool().query(
      `INSERT INTO journal_entries (room_id, agent_name, version, patch, snapshot, source)
       VALUES ($1, 'backend', 1, '{}', '{}', 'agent')`,
      [roomId],
    );
    await expect(dup).rejects.toMatchObject({ code: "23505", constraint: "journal_entries_version" });
  });
});

describe("kapı kontrolü 4, yeni hali: ikinci yazım hiçbir şey düşürmüyor", () => {
  it("v1 ve v2 duruyor; anlık alanlar korunuyor; v1'in kararı ve sözleşmesi sicilde", async () => {
    await ok("backend", { ...start, task: "auth", decisions: [decision], contracts: [login] });
    await ok("backend", { status: "done" });

    expect((await readJournalHistory(roomId, { agent: "backend" })).map((h) => h.version)).toEqual([1, 2]);
    const s = await readJournalState(roomId);
    expect(s.snapshots.backend).toMatchObject({ version: 2, status: "done", headline: "Auth başladı", task: "auth" });
    expect(s.decisions.map((d) => [d.what, d.version])).toEqual([[decision.what, 1]]);
    expect(s.contracts.map((c) => c.name)).toEqual([login.name]);
  });
});

describe("sözleşmeler", () => {
  it("birleştirme: sahibi yerinde güncelliyor, sıra korunuyor", async () => {
    await ok("backend", { ...start, contracts: [login, { name: "POST /api/logout", shape: "-> 204" }] });
    await ok("backend", { contracts: [{ ...login, shape: "-> {sessionId}", stability: "agreed" }] });
    const s = await readJournalState(roomId);
    expect(s.contracts.map((c) => [c.name, c.shape, c.stability])).toEqual([
      ["POST /api/login", "-> {sessionId}", "agreed"],
      ["POST /api/logout", "-> 204", "draft"],
    ]);
  });

  it("kaldırma: sahibi kaldırıyor", async () => {
    await ok("backend", { ...start, contracts: [login] });
    await ok("backend", { remove_contracts: [login.name] });
    expect((await readJournalState(roomId)).contracts).toEqual([]);
  });

  it("başkasının sözleşmesi: değiştirme ve kaldırma 400, hiçbir şey yazılmıyor", async () => {
    await ok("backend", { ...start, contracts: [login] });
    await ok("frontend", start);
    const [entries, events] = [await rows(), await written()];

    const change = await write("frontend", { contracts: [{ ...login, shape: "-> {jwt}" }] });
    expect(change).toMatchObject({ ok: false, status: 400, fields: ["contracts"] });
    const remove = await write("frontend", { remove_contracts: [login.name] });
    expect(remove).toMatchObject({ ok: false, status: 400, fields: ["remove_contracts"] });

    expect(await rows()).toBe(entries);
    expect(await written()).toBe(events);
    expect((await readJournalState(roomId)).contracts[0]).toMatchObject({ owner: "backend", shape: login.shape });
  });

  it("iki agent aynı yeni adı aynı anda: biri sahip olur, öteki reddedilir", async () => {
    await ok("backend", start);
    await ok("frontend", start);
    const rs = await Promise.all(["backend", "frontend"].map((a) => write(a, { contracts: [login] })));
    expect(rs.filter((r) => r.ok)).toHaveLength(1);
    expect(rs.find((r) => !r.ok)).toMatchObject({ status: 400, fields: ["contracts"] });
    expect((await readJournalState(roomId)).contracts).toHaveLength(1);
  });
});

describe("reddedilen yazım", () => {
  it("serbest metin: 400 + alan, satır ve event yok", async () => {
    const r = await write("backend", { status: "done", headline: "bitti", decisions: "JWT kullandım" });
    expect(r).toMatchObject({ ok: false, status: 400, fields: ["decisions"] });
    expect(await rows()).toBe(0);
    expect(await written()).toBe(0);
  });

  it("YAML'da olmayan agent: 404", async () => {
    expect(await write("qa", start)).toMatchObject({ ok: false, status: 404 });
  });
});

describe("host alanları event log'dan", () => {
  it("touched: bu turn'ün dosyaları, depo-göreli; payload'daki touched yok sayılıyor", async () => {
    const messageId = randomUUID();
    const other = randomUUID();
    const base = { roomId, sessionId, actor: { kind: "agent", name: "backend" } } as const;
    for (const [m, path] of [
      [messageId, "worktrees/backend/src/api/login.ts"],
      [other, "worktrees/backend/src/baska-turn.ts"],
    ] as const) {
      await appendEvent({
        ...base,
        type: "file.changed",
        payload: { agent: "backend", messageId: m, path, tool: "write_file" },
      } satisfies NewRoomEvent);
    }
    await appendEvent({
      ...base,
      type: "contract.changed",
      payload: { agent: "backend", messageId, path: "auth.md", sha256: SHA, size: 10, deleted: false },
    } satisfies NewRoomEvent);

    await ok("backend", { ...start, touched: ["/etc/passwd"] }, messageId);
    expect((await readJournalState(roomId)).snapshots.backend!.touched).toEqual(["contracts/auth.md", "src/api/login.ts"]);
  });

  it("sourceSha256: contracts/ altındaki dosyanın log'daki son sha'sı; dışındaysa ya da silinmişse null", async () => {
    const base = { roomId, sessionId, actor: { kind: "agent", name: "backend" } } as const;
    const change = (path: string, sha256: string, deleted = false) =>
      appendEvent({
        ...base,
        type: "contract.changed",
        payload: { agent: "backend", messageId: null, path, sha256, size: 1, deleted },
      } satisfies NewRoomEvent);
    await change("auth.md", "1".repeat(64));
    await change("auth.md", SHA);
    await change("gone.md", "2".repeat(64));
    await change("gone.md", "", true);

    await ok("backend", {
      ...start,
      contracts: [
        login,
        { name: "GET /gone", shape: "-> {}", file: "contracts/gone.md" },
        { name: "GET /src", shape: "-> {}", file: "src/api/openapi.yaml" },
      ],
    });
    expect((await readJournalState(roomId)).contracts.map((c) => c.sourceSha256)).toEqual([SHA, null, null]);
  });
});

describe("redaction tek geçit: tablo da temiz", () => {
  it("karardaki secret event'te ve sicilde yok", async () => {
    await ok("backend", { ...start, decisions: [{ ...decision, why: `anahtar ${SECRET} ile` }] });
    const ev = await getPool().query(
      `SELECT payload::text AS t FROM session_events WHERE room_id = $1 AND type = 'journal.entry_written'`,
      [roomId],
    );
    const reg = await getPool().query(`SELECT why FROM decision_registry WHERE room_id = $1`, [roomId]);
    const je = await getPool().query(`SELECT patch::text AS t FROM journal_entries WHERE room_id = $1`, [roomId]);
    for (const text of [ev.rows[0].t, reg.rows[0].why, je.rows[0].t]) {
      expect(text).not.toContain(SECRET);
      expect(text).toContain("[redacted:");
    }
  });
});

describe("Değişmez Kural 8: tablolar event log'un projeksiyonu", () => {
  it("event'lerin applyJournalWrite ile katlanması readJournalState'in aynısı", async () => {
    await ok("backend", { ...start, decisions: [decision], contracts: [login] });
    await ok("frontend", { ...start, decisions: [{ what: "fetch ile istek", why: "bağımlılık yok" }] });
    await ok("backend", { decisions: [{ ...decision, why: "SSR ve CSRF" }], contracts: [{ name: "GET /me", shape: "-> {id}" }] });
    await ok("frontend", { status: "done", needs_from: ["backend"] });
    await ok("backend", { remove_contracts: [login.name], decisions: [{ what: "refresh token DB'de", why: "Redis yok" }] });

    const evs = await getPool().query(
      `SELECT payload FROM session_events WHERE room_id = $1 AND type = 'journal.entry_written' ORDER BY seq`,
      [roomId],
    );
    let folded: JournalState = EMPTY_JOURNAL;
    for (const { payload: p } of evs.rows) {
      folded = applyJournalWrite(folded, {
        snapshot: p.snapshot,
        decisions: p.decisions,
        contracts: p.contracts,
        removeContracts: p.removeContracts,
      });
    }
    expect(await readJournalState(roomId)).toEqual(folded);
  });
});
