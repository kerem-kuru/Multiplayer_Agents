import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import type { NewRoomEvent } from "@agent-rooms/protocol";
import { appendEvent } from "../src/db/eventStore.js";
import { closePool, getPool } from "../src/db/pool.js";
import { AgentQueue, type QueueDeliverer, type QueueUser } from "../src/queue.js";
import { ReviewError, setCommentResolved, submitReview } from "../src/reviews.js";
import { setRoomAllowPatterns } from "../src/redaction.js";

/**
 * GERÇEK DB, SAHTE RUNNER.
 *
 * Ölçülen şey model çıktısı değil SÖZLEŞME: event sırası, çapa doğrulaması ve
 * agent'a giden metnin içeriği. "Yorum yanlış satıra uygulandı" dendiğinde
 * bakılacak ilk yer burası.
 *
 * DB yoksa atlanır.
 */

const DB = process.env.DATABASE_URL ?? "postgres://rooms:Kk2007..@localhost:5433/agent_rooms";
const AGENT = "backend";
const BASE = "cp_aaaaaaaaaaaa";

const PATCH = [
  "diff --git a/src/order.js b/src/order.js",
  "index 111..222 100644",
  "--- a/src/order.js",
  "+++ b/src/order.js",
  "@@ -1,3 +1,4 @@",
  " function processOrder(o) {",
  "+  const x = 1;",
  "   return o;",
  " }",
  "",
].join("\n");

let alive = false;
let roomId = "";
let sessionId = "";
let ayse: QueueUser;
let diffSeq = 0;
const timers: NodeJS.Timeout[] = [];

/** Turn'ü hemen bitirir; bizi ilgilendiren tek şey agent'a giden METİN. */
class CaptureRunner implements QueueDeliverer {
  queue: AgentQueue | null = null;
  delivered: Array<{ messageId: string; text: string; user: QueueUser }> = [];

  async deliverQueued(
    room: string,
    agent: string,
    msg: { messageId: string; text: string; user: QueueUser },
  ): Promise<void> {
    this.delivered.push(msg);
    // Gerçek manager'ın yaptığı şey: ham metni `message.received`'a yazmak.
    await appendEvent({
      roomId: room,
      sessionId,
      actor: { kind: "human", id: msg.user.id, name: msg.user.name },
      type: "message.received",
      payload: { agent, messageId: msg.messageId, text: msg.text },
    } satisfies NewRoomEvent);
    timers.push(setTimeout(() => void this.queue?.finishRunning(room, agent, msg.messageId), 5));
  }

  async requestInterrupt(): Promise<void> {}
}

const events = async (): Promise<Array<{ type: string; payload: Record<string, unknown> }>> => {
  const res = await getPool().query<{ type: string; payload: Record<string, unknown> }>(
    `SELECT type, payload FROM session_events WHERE session_id = $1 ORDER BY seq`,
    [sessionId],
  );
  return res.rows;
};

const draft = (over: Record<string, unknown> = {}) => ({
  path: "src/order.js",
  side: "new" as const,
  line: 2,
  lineText: "  const x = 1;",
  body: "bunu böl",
  diffSeq,
  ...over,
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
  await pool.query(
    `INSERT INTO rooms (id, name, config, config_digest) VALUES ($1, $2, $3::jsonb, $4)`,
    [
      roomId,
      "inceleme testi",
      // Agent YAML'da BULUNMALI: `submitReview` "agent yok" ile "agent'ın
      // henüz diff'i yok" durumlarını ayırıyor ve ilkine 404 veriyor.
      JSON.stringify({
        version: 1,
        name: "t",
        agents: [
          {
            name: AGENT,
            systemPrompt: "test",
            workspace: `worktrees/${AGENT}`,
          },
        ],
      }),
      "0".repeat(64),
    ],
  );
  await pool.query(`INSERT INTO sessions (id, room_id) VALUES ($1, $2)`, [sessionId, roomId]);
  const id = randomUUID();
  await pool.query(`INSERT INTO users (id, email, name) VALUES ($1, $2, $3)`, [
    id,
    `${id}@rev.test`,
    "Ayse",
  ]);
  ayse = { id, name: "Ayse" };
  setRoomAllowPatterns(roomId, []);

  // Taban + bir diff yayımı: yorum bırakılacak bir diff olmalı.
  await appendEvent({
    roomId,
    sessionId,
    actor: { kind: "system" },
    type: "checkpoint.created",
    payload: {
      agent: AGENT,
      checkpointId: BASE,
      kind: "baseline",
      label: "taban",
      commitSha: "b".repeat(40),
      treeSha: "c".repeat(40),
      messageId: null,
      by: null,
      becomesBase: true,
    },
  } satisfies NewRoomEvent);

  const stored = await appendEvent({
    roomId,
    sessionId,
    actor: { kind: "agent", name: AGENT },
    type: "diff.updated",
    payload: {
      agent: AGENT,
      messageId: null,
      baseCheckpointId: BASE,
      files: [
        {
          path: "src/order.js",
          oldPath: null,
          status: "modified",
          patch: PATCH,
          additions: 1,
          deletions: 0,
          blobHash: "a".repeat(40),
          truncated: false,
          collapsedByDefault: false,
        },
      ],
    },
  } satisfies NewRoomEvent);
  diffSeq = stored.seq;
});

afterAll(async () => {
  for (const t of timers) clearTimeout(t);
  if (!alive) return;
  const pool = getPool();
  await pool.query(`DELETE FROM agent_queue WHERE room_id = $1`, [roomId]);
  await pool.query(`DELETE FROM reviews WHERE room_id = $1`, [roomId]);
  await closePool();
});

describe("inceleme gönderme", () => {
  it("event sırası: comment.on_line ×N → review.submitted → message.queued", async () => {
    if (!alive) return;
    const runner = new CaptureRunner();
    const queue = new AgentQueue({ pool: getPool(), deliverer: runner });
    runner.queue = queue;

    const before = (await events()).length;
    const res = await submitReview(
      roomId,
      AGENT,
      ayse,
      [draft(), draft({ line: 3, lineText: "  return o;", body: "burası kalsın" })],
      queue,
    );

    expect(res.reviewId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.position).toBeGreaterThanOrEqual(1);

    const after = (await events()).slice(before);
    const types = after.map((e) => e.type);
    expect(types.slice(0, 4)).toEqual([
      "comment.on_line",
      "comment.on_line",
      "review.submitted",
      "message.queued",
    ]);

    const queued = after.find((e) => e.type === "message.queued")!;
    expect(queued.payload.reviewId).toBe(res.reviewId);

    // `reviews` satırı ve kuyruk satırı yazıldı mı.
    const review = await getPool().query(`SELECT * FROM reviews WHERE id = $1`, [res.reviewId]);
    expect(review.rowCount).toBe(1);
    const row = await getPool().query<{ kind: string; review_id: string }>(
      `SELECT kind, review_id FROM agent_queue WHERE message_id = $1`,
      [res.messageId],
    );
    expect(row.rows[0]).toMatchObject({ kind: "review", review_id: res.reviewId });

    await queue.drain();
  });

  it("agent'a giden metin dosya yolu, satır numarası ve alıntılanan satırı taşır", async () => {
    if (!alive) return;
    const runner = new CaptureRunner();
    const queue = new AgentQueue({ pool: getPool(), deliverer: runner });
    runner.queue = queue;

    await submitReview(roomId, AGENT, ayse, [draft()], queue);
    // Teslim kuyruk zincirinde; bitmesini bekle.
    await queue.drain();
    await new Promise((r) => setTimeout(r, 50));
    await queue.drain();

    const text = runner.delivered.map((d) => d.text).join("\n");
    expect(text).toContain("src/order.js:2");
    // Alıntı satırın KENDİ girintisiyle duruyor: "olduğu gibi" demek bu.
    expect(text).toContain(">   const x = 1;");
    expect(text).toContain("bunu böl");
    // `[İsim]: ` önekini manager koyuyor; kuyruğa giden metin öneksiz.
    expect(text.startsWith("[Ayse]:")).toBe(false);

    const received = (await events()).filter((e) => e.type === "message.received");
    const last = received[received.length - 1]!;
    expect(String(last.payload.text)).toContain("src/order.js:2");
    expect(String(last.payload.text)).not.toContain("[Ayse]:");
  });
});

describe("çapa doğrulaması", () => {
  const badQueue = (): AgentQueue => {
    const runner = new CaptureRunner();
    const q = new AgentQueue({ pool: getPool(), deliverer: runner });
    runner.queue = q;
    return q;
  };

  it("olmayan satıra yorum reddedilir", async () => {
    if (!alive) return;
    await expect(
      submitReview(roomId, AGENT, ayse, [draft({ line: 999 })], badQueue()),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("lineText uyuşmazsa reddedilir ve KAÇINCI yorum olduğunu söyler", async () => {
    if (!alive) return;
    try {
      await submitReview(
        roomId,
        AGENT,
        ayse,
        [draft(), draft({ line: 3, lineText: "başka bir şey" })],
        badQueue(),
      );
      expect.unreachable("reddedilmeliydi");
    } catch (err) {
      expect(err).toBeInstanceOf(ReviewError);
      expect((err as ReviewError).status).toBe(400);
      expect((err as ReviewError).detail).toMatchObject({ commentIndex: 1 });
    }
  });

  it("diff'te olmayan dosyaya yorum reddedilir", async () => {
    if (!alive) return;
    await expect(
      submitReview(roomId, AGENT, ayse, [draft({ path: "yok.js" })], badQueue()),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("gelecekten bir diffSeq reddedilir", async () => {
    if (!alive) return;
    await expect(
      submitReview(roomId, AGENT, ayse, [draft({ diffSeq: diffSeq + 1000 })], badQueue()),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("20'den fazla yorum reddedilir", async () => {
    if (!alive) return;
    const many = Array.from({ length: 21 }, () => draft());
    await expect(submitReview(roomId, AGENT, ayse, many, badQueue())).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe("çözme ve yeniden açma", () => {
  it("çöz → comment.resolved, yeniden aç → comment.reopened, tekrar çözme event yazmaz", async () => {
    if (!alive) return;
    const runner = new CaptureRunner();
    const queue = new AgentQueue({ pool: getPool(), deliverer: runner });
    runner.queue = queue;

    await submitReview(roomId, AGENT, ayse, [draft()], queue);
    const all = await events();
    const comment = [...all].reverse().find((e) => e.type === "comment.on_line")!;
    const commentId = String(comment.payload.commentId);

    const before = (await events()).length;
    await setCommentResolved(roomId, commentId, ayse, true);
    // İkinci kez çözmek yeni event yazmamalı: yarışı yut.
    await setCommentResolved(roomId, commentId, ayse, true);
    await setCommentResolved(roomId, commentId, ayse, false);

    const after = (await events()).slice(before).map((e) => e.type);
    expect(after.filter((t) => t === "comment.resolved")).toHaveLength(1);
    expect(after.filter((t) => t === "comment.reopened")).toHaveLength(1);

    await queue.drain();
  });

  it("olmayan yorum 404", async () => {
    if (!alive) return;
    await expect(setCommentResolved(roomId, randomUUID(), ayse, true)).rejects.toMatchObject({
      status: 404,
    });
  });
});
