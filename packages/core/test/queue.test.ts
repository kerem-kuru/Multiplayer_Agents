import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { closePool, getPool } from "../src/db/pool.js";
import { AgentQueue, QueueError, type QueueDeliverer, type QueueUser } from "../src/queue.js";
import { setRoomAllowPatterns } from "../src/redaction.js";

/**
 * Kuyruk testleri — GERÇEK DB, SAHTE RUNNER.
 *
 * Ölçülen tek şey eşzamanlılık: kaç kişi aynı anda yazarsa yazsın, agent
 * başına aynı anda bir tek mesaj `running` olabilir. Gerçek agent'la koşmak
 * bunu ölçmez (yavaş, pahalı ve yarışı tetiklemesi zor); sahte runner turn'ü
 * N ms sonra bitirir ve yarış pencereleri gerçeğinden GENİŞ olur.
 *
 * DB yoksa atlanır.
 */

const DB = process.env.DATABASE_URL ?? "postgres://rooms:Kk2007..@localhost:5433/agent_rooms";
const AGENT = "backend";

let alive = false;
let roomId = "";
let sessionId = "";
let ayse: QueueUser;
let ali: QueueUser;

/**
 * Sahte runner'ların bekleyen zamanlayıcıları. Test bitince temizlenir:
 * yoksa pool kapandıktan sonra ateşlenen bir `finishRunning` "Cannot use a
 * pool after calling end" hatası veriyor ve bu, YEŞİL bir koşumda kırmızı
 * gürültü yapıyor.
 */
const pendingTimers: NodeJS.Timeout[] = [];

/**
 * Sahte runner. Turn'ü `turnMs` sonra bitirir ve o an kuyruğa "bitti" der —
 * gerçek AgentManager'ın `turn_end` satırında yaptığı şey.
 *
 * Ayrıca ANLIK OLARAK kaç mesaj çalıştığını sayar: `maxConcurrent` 1'den
 * büyük olursa garanti çökmüş demektir.
 */
class FakeRunner implements QueueDeliverer {
  queue: AgentQueue | null = null;
  running = 0;
  maxConcurrent = 0;
  delivered: Array<{ messageId: string; text: string }> = [];
  interrupts: string[] = [];
  failNext = false;

  constructor(private readonly turnMs = 15) {}

  async deliverQueued(
    roomId: string,
    agentName: string,
    msg: { messageId: string; text: string; user: QueueUser },
  ): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("agent ayağa kalkamadı (test)");
    }
    this.running += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.running);
    // `[İsim]: ` önekini manager koyuyor; burada ham metin gelir.
    this.delivered.push({ messageId: msg.messageId, text: msg.text });

    pendingTimers.push(
      setTimeout(() => {
        this.running -= 1;
        void this.queue?.finishRunning(roomId, agentName, msg.messageId);
      }, this.turnMs),
    );
  }

  async requestInterrupt(
    _roomId: string,
    _agentName: string,
    msg: { messageId: string; by: QueueUser },
  ): Promise<void> {
    this.interrupts.push(msg.messageId);
  }
}

const waitFor = async (cond: () => Promise<boolean>, timeoutMs = 5000): Promise<boolean> => {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return true;
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
};

const countByStatus = async (status: string): Promise<number> => {
  const res = await getPool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM agent_queue
      WHERE room_id = $1 AND agent_name = $2 AND status = $3`,
    [roomId, AGENT, status],
  );
  return Number(res.rows[0]!.n);
};

const eventTypes = async (): Promise<string[]> => {
  const res = await getPool().query<{ type: string }>(
    `SELECT type FROM session_events WHERE session_id = $1 ORDER BY seq`,
    [sessionId],
  );
  return res.rows.map((r) => r.type);
};

const newUser = async (name: string): Promise<QueueUser> => {
  const id = randomUUID();
  await getPool().query(`INSERT INTO users (id, email, name) VALUES ($1, $2, $3)`, [
    id,
    `${id}@queue.test`,
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
    [
      roomId,
      "kuyruk testi",
      JSON.stringify({ version: 1, name: "t", agents: [] }),
      "0".repeat(64),
    ],
  );
  await pool.query(`INSERT INTO sessions (id, room_id) VALUES ($1, $2)`, [sessionId, roomId]);
  setRoomAllowPatterns(roomId, []);
  ayse = await newUser("Ayse");
  ali = await newUser("Ali");
});

afterAll(async () => {
  for (const t of pendingTimers) clearTimeout(t);
  if (!alive) return;
  // Kuyruk satırları silinebilir (event log DEĞİL, güncel durum).
  await getPool().query(`DELETE FROM agent_queue WHERE room_id = $1`, [roomId]);
  await closePool();
});

describe.runIf(process.env.SKIP_DB !== "1")("agent kuyruğu", () => {
  it("iki mesaj ASLA paralel koşmuyor — 10 paralel enqueue", async () => {
    if (!alive) return;
    const runner = new FakeRunner(10);
    const queue = new AgentQueue({ pool: getPool(), deliverer: runner });
    runner.queue = queue;

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        queue.enqueue(roomId, AGENT, i % 2 === 0 ? ayse : ali, `mesaj ${i}`),
      ),
    );
    expect(results).toHaveLength(10);

    // Hepsi sırayla koşsun.
    expect(await waitFor(async () => (await countByStatus("done")) === 10, 10_000)).toBe(true);
    await queue.drain();

    // Tek koşan garantisi: sahte runner anlık eşzamanlılığı sayıyor.
    expect(runner.maxConcurrent).toBe(1);
    // Hiçbiri kaybolmadı ve sıra ENQUEUE sırasıyla aynı.
    expect(runner.delivered).toHaveLength(10);
    /**
     * Koşma sırası KUYRUĞA GİRİŞ sırasıyla aynı.
     *
     * "Girdiği sıra" burada `ord` sayacı: 10 istek paralel gittiği için
     * hangisinin DB'ye önce değdiği belirsizdir ve olması gereken de bu.
     * Garanti edilen şey, kuyruğa giriş sırası ne olduysa koşma sırasının
     * ONUNLA AYNI olması.
     */
    const inserted = await getPool().query<{ text: string }>(
      `SELECT text FROM agent_queue WHERE room_id = $1 AND agent_name = $2 ORDER BY ord`,
      [roomId, AGENT],
    );
    expect(runner.delivered.map((d) => d.text)).toEqual(inserted.rows.map((r) => r.text));
  });

  it("DB kısmi unique index ikinci 'running' satırı REDDEDİYOR", async () => {
    if (!alive) return;
    const pool = getPool();
    const room2 = randomUUID();
    await pool.query(
      `INSERT INTO rooms (id, name, config, config_digest) VALUES ($1, $2, $3::jsonb, $4)`,
      [room2, "index testi", JSON.stringify({ version: 1, name: "t", agents: [] }), "1".repeat(64)],
    );
    try {
      await pool.query(
        `INSERT INTO agent_queue (room_id, agent_name, message_id, user_id, text, status)
         VALUES ($1, 'x', $2, $3, 'bir', 'running')`,
        [room2, randomUUID(), ayse.id],
      );
      // Kodda bir yarış kalsa bile buraya gelinemez: DB son sözü söylüyor.
      await expect(
        pool.query(
          `INSERT INTO agent_queue (room_id, agent_name, message_id, user_id, text, status)
           VALUES ($1, 'x', $2, $3, 'iki', 'running')`,
          [room2, randomUUID(), ayse.id],
        ),
      ).rejects.toThrow(/agent_queue_single_running|duplicate key/i);
    } finally {
      await pool.query(`DELETE FROM agent_queue WHERE room_id = $1`, [room2]);
      await pool.query(`DELETE FROM rooms WHERE id = $1`, [room2]);
    }
  });

  it("iptal edilen mesaj HİÇ çalışmıyor", async () => {
    if (!alive) return;
    // Uzun turn: ilk mesaj koşarken ikinciyi iptal etmeye vaktimiz olsun.
    const runner = new FakeRunner(300);
    const queue = new AgentQueue({ pool: getPool(), deliverer: runner });
    runner.queue = queue;

    const first = await queue.enqueue(roomId, AGENT, ayse, "uzun is");
    const second = await queue.enqueue(roomId, AGENT, ali, "iptal edilecek");
    expect(second.position).toBeGreaterThan(1);

    await queue.cancel(roomId, second.messageId, ali, { isDriver: false, isOwner: false });

    expect(await waitFor(async () => runner.delivered.some((d) => d.messageId === first.messageId)))
      .toBe(true);
    await new Promise((r) => setTimeout(r, 600));
    await queue.drain();

    // İptal edilen mesaj runner'a HİÇ gitmedi.
    expect(runner.delivered.some((d) => d.messageId === second.messageId)).toBe(false);
    const types = await eventTypes();
    expect(types).toContain("message.cancelled");
  });

  it("başkasının kaydını iptal 403, sürücü/owner ise olur", async () => {
    if (!alive) return;
    const runner = new FakeRunner(400);
    const queue = new AgentQueue({ pool: getPool(), deliverer: runner });
    runner.queue = queue;

    await queue.enqueue(roomId, AGENT, ayse, "kosan is");
    const mine = await queue.enqueue(roomId, AGENT, ayse, "ayse'nin kaydi");

    await expect(
      queue.cancel(roomId, mine.messageId, ali, { isDriver: false, isOwner: false }),
    ).rejects.toMatchObject({ status: 403 });

    // Sürücü başkasının kaydını iptal EDEBİLİR.
    await expect(
      queue.cancel(roomId, mine.messageId, ali, { isDriver: true, isOwner: false }),
    ).resolves.toMatchObject({ agentName: AGENT });

    await new Promise((r) => setTimeout(r, 500));
    await queue.drain();
  });

  it("koşan mesaj iptal edilmiyor — 409 ile kesmeye yönlendiriyor", async () => {
    if (!alive) return;
    const runner = new FakeRunner(400);
    const queue = new AgentQueue({ pool: getPool(), deliverer: runner });
    runner.queue = queue;

    const first = await queue.enqueue(roomId, AGENT, ayse, "kesilmesi gereken");
    expect(await waitFor(async () => (await countByStatus("running")) === 1)).toBe(true);

    await expect(
      queue.cancel(roomId, first.messageId, ayse, { isDriver: true, isOwner: true }),
    ).rejects.toMatchObject({ status: 409 });

    // Kesme yolu: koşan mesajın kimliğini kuyruk kendisi bulur.
    const interrupted = await queue.interruptRunning(roomId, AGENT, ayse);
    expect(interrupted).toBe(first.messageId);
    expect(runner.interrupts).toContain(first.messageId);

    await new Promise((r) => setTimeout(r, 500));
    await queue.drain();
  });

  it("koşan turn yokken kesme 409", async () => {
    if (!alive) return;
    const runner = new FakeRunner(10);
    const queue = new AgentQueue({ pool: getPool(), deliverer: runner });
    runner.queue = queue;
    await expect(queue.interruptRunning(roomId, "bos-agent", ayse)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("kuyruk sınırı: 11. mesaj 429", async () => {
    if (!alive) return;
    // Turn hiç bitmesin: teslim edilen mesaj `running` kalsın ve 10 tane
    // `queued` birikebilsin.
    const runner = new FakeRunner(60_000);
    const queue = new AgentQueue({ pool: getPool(), deliverer: runner });
    runner.queue = queue;

    await queue.enqueue(roomId, "dolu-agent", ayse, "kosan");
    expect(
      await waitFor(async () => {
        const res = await getPool().query<{ n: string }>(
          `SELECT count(*)::text AS n FROM agent_queue
            WHERE room_id = $1 AND agent_name = 'dolu-agent' AND status = 'running'`,
          [roomId],
        );
        return Number(res.rows[0]!.n) === 1;
      }),
    ).toBe(true);

    for (let i = 0; i < 10; i++) {
      await queue.enqueue(roomId, "dolu-agent", ayse, `bekleyen ${i}`);
    }
    await expect(queue.enqueue(roomId, "dolu-agent", ayse, "fazlalik")).rejects.toMatchObject({
      status: 429,
    });
  });

  it("8000 karakteri aşan mesaj 400 — sessizce kırpılmıyor", async () => {
    if (!alive) return;
    const runner = new FakeRunner(10);
    const queue = new AgentQueue({ pool: getPool(), deliverer: runner });
    runner.queue = queue;
    await expect(
      queue.enqueue(roomId, "uzun-agent", ayse, "a".repeat(8001)),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("agent failed olunca kuyruk temizleniyor", async () => {
    if (!alive) return;
    // İlk turn test boyunca BİTMEMELİ: 10 ms'lik turn yük altında
    // `agentFailed`'dan önce bitiyor, "iki" teslim ediliyor ve iptal edilecek
    // `queued` kayıt kalmıyordu. Zamanlayıcıyı afterAll temizliyor.
    const runner = new FakeRunner(60_000);
    const queue = new AgentQueue({ pool: getPool(), deliverer: runner });
    runner.queue = queue;

    await queue.enqueue(roomId, "kirik-agent", ayse, "bir");
    await queue.enqueue(roomId, "kirik-agent", ali, "iki");
    await queue.drain();

    const cancelled = await queue.agentFailed(roomId, "kirik-agent");
    expect(cancelled).toBeGreaterThanOrEqual(1);

    const res = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM agent_queue
        WHERE room_id = $1 AND agent_name = 'kirik-agent' AND status = 'queued'`,
      [roomId],
    );
    expect(Number(res.rows[0]!.n)).toBe(0);
  });

  it("teslim edilemeyen mesaj kuyruğu tıkamıyor", async () => {
    if (!alive) return;
    const runner = new FakeRunner(10);
    const queue = new AgentQueue({ pool: getPool(), deliverer: runner });
    runner.queue = queue;
    runner.failNext = true;

    await queue.enqueue(roomId, "kalkamayan", ayse, "bu teslim edilemeyecek");
    await queue.drain();
    await new Promise((r) => setTimeout(r, 100));

    // `running` satır kalmadı: kalsaydı o agent'ın kuyruğu sonsuza kadar tıkanırdı.
    const res = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM agent_queue
        WHERE room_id = $1 AND agent_name = 'kalkamayan' AND status IN ('queued','running')`,
      [roomId],
    );
    expect(Number(res.rows[0]!.n)).toBe(0);
  });

  it("event sırası: message.queued → message.received (iptalde received YOK)", async () => {
    if (!alive) return;
    const pool = getPool();
    const runner = new FakeRunner(10);
    const queue = new AgentQueue({ pool, deliverer: runner });
    runner.queue = queue;

    const { messageId } = await queue.enqueue(roomId, "sira-agent", ayse, "sirali is");
    expect(await waitFor(async () => runner.delivered.some((d) => d.messageId === messageId))).toBe(
      true,
    );

    const res = await pool.query<{ type: string; seq: string }>(
      `SELECT type, seq::text FROM session_events
        WHERE session_id = $1 AND payload->>'messageId' = $2 ORDER BY seq`,
      [sessionId, messageId],
    );
    // `message.received` manager'ın işi; sahte runner onu yazmıyor. Kuyruğun
    // yazdığı event burada: `message.queued` ve tek başına ilk sırada.
    expect(res.rows[0]?.type).toBe("message.queued");

    // Ham metin: `[Ayse]: ` öneki event log'da YOK.
    const payload = await pool.query<{ text: string }>(
      `SELECT payload->>'text' AS text FROM session_events
        WHERE session_id = $1 AND payload->>'messageId' = $2 AND type = 'message.queued'`,
      [sessionId, messageId],
    );
    expect(payload.rows[0]!.text).toBe("sirali is");
    expect(payload.rows[0]!.text).not.toContain("[Ayse]");
  });

  it("sunucu yeniden başlarken: running iptal, queued korunuyor", async () => {
    if (!alive) return;
    const pool = getPool();
    const agent = "restart-agent";
    // Elle kur: biri koşuyor, ikisi bekliyor.
    const runningId = randomUUID();
    await pool.query(
      `INSERT INTO agent_queue (room_id, agent_name, message_id, user_id, text, status, started_at)
       VALUES ($1, $2, $3, $4, 'kosuyordu', 'running', now())`,
      [roomId, agent, runningId, ayse.id],
    );
    for (const t of ["restart-bekleyen 1", "restart-bekleyen 2"]) {
      await pool.query(
        `INSERT INTO agent_queue (room_id, agent_name, message_id, user_id, text)
         VALUES ($1, $2, $3, $4, $5)`,
        [roomId, agent, randomUUID(), ali.id, t],
      );
    }

    const runner = new FakeRunner(10);
    const queue = new AgentQueue({ pool, deliverer: runner });
    runner.queue = queue;

    const res = await queue.reconcileOnBoot();
    expect(res.cancelled).toBeGreaterThanOrEqual(1);
    await queue.drain();
    expect(await waitFor(async () => (await pendingOf(agent)) === 0, 8000)).toBe(true);

    // Kesilen mesaj YENİDEN KOŞMUYOR.
    expect(runner.delivered.some((d) => d.messageId === runningId)).toBe(false);
    // Bekleyenler akmaya devam etti.
    // Sadece BU agent'ın bekleyenleri: `reconcileOnBoot` bütün odaları tarar
    // ve başka testlerin bıraktığı kuyruklar da akmaya başlar.
    expect(runner.delivered.filter((d) => d.text.startsWith("restart-bekleyen"))).toHaveLength(2);

    const types = await pool.query<{ type: string; reason: string }>(
      `SELECT type, payload->>'reason' AS reason FROM session_events
        WHERE session_id = $1 AND payload->>'messageId' = $2`,
      [sessionId, runningId],
    );
    expect(types.rows.some((r) => r.type === "message.cancelled" && r.reason === "server_restart"))
      .toBe(true);
  });
});

async function pendingOf(agent: string): Promise<number> {
  const res = await getPool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM agent_queue
      WHERE room_id = $1 AND agent_name = $2 AND status IN ('queued','running')`,
    [roomId, agent],
  );
  return Number(res.rows[0]!.n);
}
