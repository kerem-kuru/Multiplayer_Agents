import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { RoomConfig, RunnerCommand, RunnerOutput, type RpcResponse } from "@agent-rooms/protocol";
import { RpcBridge, rpcCall } from "@agent-rooms/gitkit";
import { closePool, getPool } from "../src/db/pool.js";
import { setRoomAllowPatterns } from "../src/redaction.js";
import { RpcHost, type RpcHandler } from "../src/rpc.js";

/**
 * Hafta 8, Adım 4 — runner RPC kanalı.
 *
 * Görev tanımının kabulü: gidiş-dönüş, zaman aşımı, bilinmeyen method,
 * kimlik sahteciliği. Ek olarak: açık RPC sınırı, RPC'nin log'a yazılmaması,
 * soket köprüsü (izin, istemci id'leri, host cevapsız kalınca).
 *
 * "Sahte runner" = gerçek `RpcBridge` + gerçek `RpcHost`, aralarındaki hat
 * `RunnerOutput` / `RunnerCommand` şemalarından JSON olarak geçiyor; eksik
 * olan yalnızca `docker exec`. DB isteyen testler DB yoksa atlanır.
 */

const DB = process.env.DATABASE_URL ?? "postgres://rooms:Kk2007..@localhost:5433/agent_rooms";

const sockPath = (): string =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\rooms-rpc-test-${randomUUID()}`
    : path.join(tmpdir(), `rooms-rpc-${randomUUID()}`, "rpc.sock");

const bridges: RpcBridge[] = [];
afterEach(async () => {
  await Promise.all(bridges.splice(0).map((b) => b.close()));
});

/** Köprü ↔ host, aradaki hat NDJSON satırı olarak şemalardan geçer. */
async function wire(host: (send: (r: RpcResponse) => void) => RpcHost, bridgeTimeoutMs?: number) {
  let bridge!: RpcBridge;
  const h = host((r) => {
    const cmd = RunnerCommand.parse(JSON.parse(JSON.stringify({ kind: "rpc_result", ...r })));
    if (cmd.kind === "rpc_result") bridge.onResult(cmd);
  });
  bridge = new RpcBridge({
    socketPath: sockPath(),
    timeoutMs: bridgeTimeoutMs,
    send: (o) => {
      const line = RunnerOutput.parse(JSON.parse(JSON.stringify(o)));
      if (line.kind === "rpc") void h.handle(line);
    },
  });
  await bridge.listen();
  bridges.push(bridge);
  return { bridge, host: h, call: (method: string, params: unknown = {}) => rpcCall(bridge.socketPath, method, params) };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

// --- DB'siz: host kuralları ---------------------------------------------------

describe("RpcHost — taşıma kuralları", () => {
  const base = { roomId: randomUUID(), agentName: "frontend", currentMessageId: async () => null };

  it("bilinmeyen method ok:false; prototip adları method sayılmaz", async () => {
    const sent: RpcResponse[] = [];
    const host = new RpcHost({ ...base, handlers: {}, send: (r) => sent.push(r) });
    await host.handle({ id: "1", method: "journal.delete", params: {} });
    await host.handle({ id: "2", method: "toString", params: {} });
    expect(sent).toEqual([
      { id: "1", ok: false, error: "bilinmeyen method: journal.delete" },
      { id: "2", ok: false, error: "bilinmeyen method: toString" },
    ]);
  });

  it("zaman aşımı: cevap bir kez gider, handler bitene kadar sayaç düşmez", async () => {
    const gate = deferred();
    const sent: RpcResponse[] = [];
    const slow: RpcHandler = async () => {
      await gate.promise;
      return "geç";
    };
    const host = new RpcHost({ ...base, handlers: { slow }, timeoutMs: 30, send: (r) => sent.push(r) });
    const done = host.handle({ id: "a", method: "slow", params: null });
    await new Promise((r) => setTimeout(r, 80));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ id: "a", ok: false });
    expect(sent[0].error).toMatch(/zaman aşımı/);
    expect(host.openCount).toBe(1);
    gate.resolve();
    await done;
    expect(sent).toHaveLength(1); // geç gelen sonuç ikinci kez gönderilmedi
    expect(host.openCount).toBe(0);
  });

  it("açık RPC sınırı: 9. istek beklemeden hata alır", async () => {
    const gate = deferred();
    const sent: RpcResponse[] = [];
    const block: RpcHandler = async () => {
      await gate.promise;
      return true;
    };
    const host = new RpcHost({ ...base, handlers: { block }, send: (r) => sent.push(r) });
    const open = Array.from({ length: 8 }, (_, i) => host.handle({ id: `o${i}`, method: "block", params: null }));
    await new Promise((r) => setImmediate(r));
    await host.handle({ id: "dokuzuncu", method: "block", params: null });
    expect(sent).toEqual([{ id: "dokuzuncu", ok: false, error: "aynı anda en fazla 8 açık istek" }]);
    gate.resolve();
    await Promise.all(open);
    expect(sent.filter((r) => r.ok)).toHaveLength(8);
    expect(host.openCount).toBe(0);
  });

  it("handler istisnası ok:false olur, fırlatmaz", async () => {
    const sent: RpcResponse[] = [];
    const boom: RpcHandler = async () => {
      throw new Error("bağlantı koptu");
    };
    const host = new RpcHost({ ...base, handlers: { boom }, send: (r) => sent.push(r) });
    await host.handle({ id: "x", method: "boom", params: null });
    expect(sent).toEqual([{ id: "x", ok: false, error: "host hatası: bağlantı koptu" }]);
  });

  it("gönderim hatası (runner kapanmış) handle'ı düşürmez", async () => {
    const echo: RpcHandler = async () => 1;
    const host = new RpcHost({
      ...base,
      handlers: { echo },
      send: () => {
        throw new Error("stdin kapalı");
      },
    });
    await expect(host.handle({ id: "y", method: "echo", params: null })).resolves.toBeUndefined();
  });
});

// --- DB'siz: soket köprüsü ------------------------------------------------------

describe("RpcBridge — soket", () => {
  const echoHost = (send: (r: RpcResponse) => void) =>
    new RpcHost({
      roomId: randomUUID(),
      agentName: "frontend",
      currentMessageId: async () => null,
      handlers: { echo: async (ctx, params) => ({ agent: ctx.agentName, params }) },
      send,
    });

  it("gidiş-dönüş; kimlik host'tan gelir", async () => {
    const { call } = await wire(echoHost);
    const r = await call("echo", { agent: "backend", n: 1 });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ agent: "frontend", params: { agent: "backend", n: 1 } });
  });

  it.skipIf(process.platform === "win32")("soket 0600, dizini 0700", async () => {
    const { bridge } = await wire(echoHost);
    expect(statSync(bridge.socketPath).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(bridge.socketPath)).mode & 0o777).toBe(0o700);
  });

  it("iki istemci aynı id'yi kullansa da cevaplar karışmaz", async () => {
    const { bridge } = await wire(echoHost);
    const send = (n: number) =>
      new Promise<RpcResponse>((resolve, reject) => {
        // `rpcCall` her isteğe yeni id veriyor; burada bilerek ikisi de "1".
        import("node:net").then(({ default: net }) => {
          const s = net.createConnection(bridge.socketPath);
          s.setEncoding("utf8");
          s.on("connect", () => s.write(JSON.stringify({ id: "1", method: "echo", params: { n } }) + "\n"));
          s.on("data", (d: string) => {
            resolve(JSON.parse(d.split("\n")[0]));
            s.destroy();
          });
          s.on("error", reject);
        }, reject);
      });
    const [a, b] = await Promise.all([send(1), send(2)]);
    expect(a).toMatchObject({ id: "1", ok: true, data: { params: { n: 1 } } });
    expect(b).toMatchObject({ id: "1", ok: true, data: { params: { n: 2 } } });
    expect(bridge.pendingCount).toBe(0);
  });

  it("host hiç cevap vermezse köprü kendi zaman aşımıyla döner", async () => {
    const bridge = new RpcBridge({ socketPath: sockPath(), timeoutMs: 40, send: () => undefined });
    await bridge.listen();
    bridges.push(bridge);
    const r = await rpcCall(bridge.socketPath, "journal.read", {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cevap vermedi/);
    expect(bridge.pendingCount).toBe(0);
  });

  it("bozuk istek ok:false alır, bağlantı yaşar", async () => {
    const { bridge } = await wire(echoHost);
    const net = (await import("node:net")).default;
    const lines = await new Promise<string[]>((resolve, reject) => {
      const s = net.createConnection(bridge.socketPath);
      s.setEncoding("utf8");
      let buf = "";
      s.on("connect", () => s.write("serbest metin\n" + JSON.stringify({ id: "2", method: "echo", params: 0 }) + "\n"));
      s.on("data", (d: string) => {
        buf += d;
        const got = buf.split("\n").filter(Boolean);
        if (got.length === 2) {
          s.destroy();
          resolve(got);
        }
      });
      s.on("error", reject);
    });
    expect(JSON.parse(lines[0])).toMatchObject({ id: "?", ok: false });
    expect(JSON.parse(lines[1])).toMatchObject({ id: "2", ok: true });
  });
});

// --- DB: defter method'ları ----------------------------------------------------

let alive = false;
let roomId = "";
let sessionId = "";

beforeAll(async () => {
  process.env.DATABASE_URL = DB;
  try {
    const probe = new pg.Client({ connectionString: DB, connectionTimeoutMillis: 2000 });
    await probe.connect();
    await probe.end();
    alive = true;
  } catch {
    /* DB yok: defter testleri atlanır */
  }
});

afterAll(async () => {
  if (alive) await closePool();
});

describe("journal.read / journal.write — gerçek DB", () => {
  beforeEach(async (ctx) => {
    if (!alive) return ctx.skip();
    const pool = getPool();
    roomId = randomUUID();
    sessionId = randomUUID();
    await pool.query(`INSERT INTO rooms (id, name, config, config_digest) VALUES ($1, $2, $3::jsonb, $4)`, [
      roomId,
      "rpc testi",
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
  });

  const journalHost = (agentName: string, messageId: string | null = null) => (send: (r: RpcResponse) => void) =>
    new RpcHost({ roomId, agentName, currentMessageId: async () => messageId, send, pool: getPool() });

  const events = async () =>
    (
      await getPool().query<{ type: string }>(`SELECT type FROM session_events WHERE room_id = $1 ORDER BY seq`, [
        roomId,
      ])
    ).rows.map((r) => r.type);

  const decision = { what: "JWT yerine session cookie", why: "frontend SSR gerektiriyor", affects: ["frontend"] };

  it("yazım ve okuma gidiş-dönüşü; koşan turn messageId olarak gider", async () => {
    const messageId = randomUUID();
    const { call } = await wire(journalHost("backend", messageId));

    const w = await call("journal.write", { status: "in_progress", headline: "Auth", decisions: [decision] });
    expect(w).toMatchObject({ ok: true, data: { accepted: true, version: 1 } });

    const r = await call("journal.read");
    expect(r.ok).toBe(true);
    const state = r.data as { snapshots: Record<string, { version: number }>; decisions: Array<{ what: string; owner: string }> };
    expect(state.snapshots.backend.version).toBe(1);
    expect(state.decisions).toEqual([expect.objectContaining({ what: decision.what, owner: "backend" })]);

    const row = await getPool().query(`SELECT message_id, source FROM journal_entries WHERE room_id = $1`, [roomId]);
    expect(row.rows).toEqual([{ message_id: messageId, source: "agent" }]);
  });

  /*
   * İki yol, ikisi de sahteciliği tutmaz:
   * - `agent` host alanı (Adım 1): sessizce atılır, yazım koşan agent'a gider.
   * - `agentName` / `roomId` şemada yok; şema `.strict()` olduğu için
   *   REDDEDİLİR (öğretici hata) — hiçbir odaya hiçbir şey yazılmaz.
   */
  it("kimlik sahteciliği: params'taki `agent` yok sayılır, yazım koşan agent'a gider", async () => {
    const { call } = await wire(journalHost("frontend"));
    const w = await call("journal.write", {
      agent: "backend",
      status: "in_progress",
      headline: "ben backend'im",
      decisions: [decision],
    });
    expect(w).toMatchObject({ ok: true, data: { accepted: true, version: 1 } });

    const rows = await getPool().query(`SELECT agent_name FROM journal_entries WHERE room_id = $1`, [roomId]);
    expect(rows.rows).toEqual([{ agent_name: "frontend" }]);
    const owners = await getPool().query(`SELECT owner FROM decision_registry WHERE room_id = $1`, [roomId]);
    expect(owners.rows).toEqual([{ owner: "frontend" }]);
  });

  it("kimlik sahteciliği: başka oda / agent adı alanı reddedilir, hiçbir yere yazılmaz", async () => {
    const other = randomUUID();
    const { call } = await wire(journalHost("frontend"));
    const w = await call("journal.write", { roomId: other, agentName: "backend", status: "in_progress" });
    expect(w).toMatchObject({ ok: true, data: { accepted: false, status: 400 } });
    const rows = await getPool().query(`SELECT count(*)::int AS n FROM journal_entries WHERE room_id = ANY($1)`, [
      [roomId, other],
    ]);
    expect(rows.rows[0].n).toBe(0);
  });

  it("doğrulama reddi bir sonuçtur: ok:true, accepted:false, alanlar; hiçbir şey yazılmaz", async () => {
    const { call } = await wire(journalHost("backend"));
    const w = await call("journal.write", { decisions: "JWT yerine cookie kullandım" });
    expect(w.ok).toBe(true);
    expect(w.data).toMatchObject({ accepted: false, status: 400 });
    expect((w.data as { fields: string[] }).fields).toContain("decisions");
    expect(await events()).toEqual([]);
  });

  it("RPC trafiği log'a yazılmaz: okuma iz bırakmaz, yazım yalnızca journal.entry_written", async () => {
    const { call } = await wire(journalHost("backend"));
    await call("journal.read");
    expect(await events()).toEqual([]);
    await call("journal.write", { status: "in_progress", headline: "Auth" });
    expect(await events()).toEqual(["journal.entry_written"]);
  });
});
