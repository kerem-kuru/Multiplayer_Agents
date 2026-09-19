import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { NewRoomEvent } from "@agent-rooms/protocol";
import { appendEvent } from "./db/eventStore.js";
import { getPool } from "./db/pool.js";
import { latestSession } from "./room/rooms.js";

/**
 * Mesaj kuyruğu ve zamanlayıcı.
 *
 * TEK KURAL, HER ŞEYİN SEBEBİ BU: **agent başına aynı anda en fazla bir mesaj
 * inference'ta.** İki mesaj paralel girerse agent'ın context'i bozulur ve hata
 * SESSİZCE oluşur — kimse fark etmez, sadece cevaplar saçmalar.
 *
 * Garanti üç katmanlı ve katmanlar birbirinin yedeği:
 *   1. Bellekte agent başına promise zinciri — `tick` aynı anda iki kez koşmaz.
 *   2. `FOR UPDATE SKIP LOCKED` — iki seçici aynı satırı alamaz.
 *   3. `agent_queue_single_running` kısmi unique index — kodda gözden kaçan
 *      bir yarış kalsa bile DB ikinci `running` satırını REDDEDER.
 *
 * KUYRUK DB'DE. Bellekteki bir dizi ikinci kullanıcıya görünmez ve çökmede
 * uçar; sunucu yeniden başladığında bekleyen mesajlar kaybolmamalı.
 *
 * MESAJLAR BİRLEŞTİRİLMEZ. A ve B arka arkaya yazdığında "ikisini tek
 * prompt'ta gönderelim" cazip gelir; yapılmaz. Agent kime cevap verdiğini
 * kaybeder ve iki yönerge tek turn'de karışır. Her mesaj kendi turn'ünü alır.
 */

/** Tek mesajın üst sınırı. Aşarsa `400` — sessizce kırpmak yönergeyi bozar. */
export const QUEUE_MAX_TEXT = 8000;
/** Agent başına bekleyen mesaj sınırı. Aşarsa `429`. */
export const QUEUE_MAX_QUEUED = 10;

export type QueueStatus = "queued" | "running" | "done" | "cancelled";

export interface QueueUser {
  id: string;
  name: string;
}

export interface QueueEntry {
  messageId: string;
  agentName: string;
  user: QueueUser;
  text: string;
  status: QueueStatus;
  enqueuedAt: string;
  startedAt: string | null;
}

/** HTTP durumunu taşıyan hata: API katmanı çeviri uydurmasın. */
export class QueueError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "QueueError";
  }
}

/**
 * Kuyruğun runner tarafına bakan yüzü — `AgentManager` bunu uygular.
 *
 * Kuyruk runner'ı tanımaz, yalnızca "şu mesajı ver" der. Tersi olsaydı
 * (manager kuyruğu çağırsa) sıralama iki yere dağılırdı.
 */
export interface QueueDeliverer {
  /**
   * Mesajı agent'a ver: gerekiyorsa agent'ı başlat ve `ready` bekle,
   * `message.received` yaz, runtime'ı `busy` yap, runner'a `run` gönder.
   *
   * Metnin başına `[İsim]: ` önekini KOYAN BURASI — event log'daki ham metin
   * öneksiz kalır.
   */
  deliverQueued(
    roomId: string,
    agentName: string,
    msg: { messageId: string; text: string; user: QueueUser },
  ): Promise<void>;

  /** Koşan turn'ü kes: `interrupt.requested` yazan ve sert kesmeyi kuran taraf. */
  requestInterrupt(
    roomId: string,
    agentName: string,
    msg: { messageId: string; by: QueueUser },
  ): Promise<void>;
}

export interface AgentQueueOptions {
  pool?: pg.Pool;
  deliverer: QueueDeliverer;
  log?: (level: "info" | "warn" | "error", msg: string, extra?: unknown) => void;
}

interface Row {
  id: string;
  room_id: string;
  agent_name: string;
  message_id: string;
  user_id: string;
  user_name: string;
  text: string;
  status: QueueStatus;
  enqueued_at: Date;
  started_at: Date | null;
}

const toEntry = (r: Row): QueueEntry => ({
  messageId: r.message_id,
  agentName: r.agent_name,
  user: { id: r.user_id, name: r.user_name },
  text: r.text,
  status: r.status,
  enqueuedAt: r.enqueued_at.toISOString(),
  startedAt: r.started_at?.toISOString() ?? null,
});

const SELECT_COLS = `q.id, q.room_id, q.agent_name, q.message_id, q.user_id,
                     u.name AS user_name, q.text, q.status, q.enqueued_at, q.started_at`;

/**
 * FIFO sırası `ord` (artan sayaç) üzerinden.
 *
 * `enqueued_at` ile sıralamak YETMEDİ: paralel iki INSERT aynı mikrosaniyeye
 * düşebiliyor ve sıra rastgele UUID'ye kalıyordu — 10 paralel mesajla ölçüldü,
 * sıra bozuldu. Kuyruğun tek işi sırayı garanti etmek; eşitliğe yer yok.
 */
const FIFO = `q.ord`;

export class AgentQueue {
  private readonly pool: pg.Pool;
  private readonly deliverer: QueueDeliverer;
  private readonly log: NonNullable<AgentQueueOptions["log"]>;
  /** Agent başına tek `tick`: bellekteki ilk emniyet katmanı. */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(opts: AgentQueueOptions) {
    this.pool = opts.pool ?? getPool();
    this.deliverer = opts.deliverer;
    this.log = opts.log ?? (() => undefined);
  }

  private key(roomId: string, agentName: string): string {
    return `${roomId}:${agentName}`;
  }

  private async sessionId(roomId: string): Promise<string> {
    const session = await latestSession(roomId, this.pool);
    if (!session) throw new QueueError(404, `odanın oturumu yok: ${roomId}`);
    return session.id;
  }

  // --- yazma --------------------------------------------------------------

  /**
   * Mesajı kuyruğa ekle. Üyelik ve rol kontrolü ÇAĞIRAN KATMANIN işi
   * (`requireRoom`); burada yalnızca kuyruk kuralları var.
   *
   * `position`: 1 = sıradaki ilk. Koşan bir mesaj varsa o 1'dir.
   */
  async enqueue(
    roomId: string,
    agentName: string,
    user: QueueUser,
    text: string,
  ): Promise<{ messageId: string; position: number }> {
    const body = text.trim();
    if (body.length === 0) throw new QueueError(400, "mesaj boş");
    if (body.length > QUEUE_MAX_TEXT) {
      throw new QueueError(400, `mesaj ${QUEUE_MAX_TEXT} karakteri aşıyor (${body.length})`);
    }

    const sessionId = await this.sessionId(roomId);

    const pending = await this.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM agent_queue
        WHERE room_id = $1 AND agent_name = $2 AND status = 'queued'`,
      [roomId, agentName],
    );
    if (Number(pending.rows[0]?.n ?? "0") >= QUEUE_MAX_QUEUED) {
      throw new QueueError(429, `bu agent için kuyruk dolu (${QUEUE_MAX_QUEUED})`, {
        maxQueued: QUEUE_MAX_QUEUED,
      });
    }

    const messageId = randomUUID();
    await this.pool.query(
      `INSERT INTO agent_queue (room_id, agent_name, message_id, user_id, text)
       VALUES ($1, $2, $3, $4, $5)`,
      [roomId, agentName, messageId, user.id, body],
    );

    /**
     * Event SIRASI: kayıt DB'de, sonra log'a. Ters olsaydı log'da duran ama
     * kuyrukta olmayan bir mesaj görünebilirdi.
     *
     * `text` HAM metin — `[İsim]: ` öneki burada yok, runner'a verilirken
     * ekleniyor.
     */
    await appendEvent(
      {
        roomId,
        sessionId,
        actor: { kind: "human", id: user.id, name: user.name },
        type: "message.queued",
        payload: { agent: agentName, messageId, text: body, user },
      } satisfies NewRoomEvent,
      this.pool,
    );

    const position = await this.position(roomId, agentName, messageId);

    // Zamanlayıcıyı dürt. BEKLEMEDEN: turn'ün bitmesini beklemek isteği asar.
    void this.tick(roomId, agentName);

    return { messageId, position };
  }

  /** Sıradaki yer. 1 = ilk. Koşan mesaj varsa o 1'dir. */
  async position(roomId: string, agentName: string, messageId: string): Promise<number> {
    const res = await this.pool.query<{ before: string; running: string }>(
      `SELECT
         (SELECT count(*) FROM agent_queue b
           WHERE b.room_id = $1 AND b.agent_name = $2 AND b.status = 'queued'
             AND b.ord < (SELECT m.ord FROM agent_queue m WHERE m.message_id = $3))::text
           AS before,
         (SELECT count(*) FROM agent_queue r
           WHERE r.room_id = $1 AND r.agent_name = $2 AND r.status = 'running')::text
           AS running`,
      [roomId, agentName, messageId],
    );
    const row = res.rows[0];
    return Number(row?.before ?? "0") + 1 + Number(row?.running ?? "0");
  }

  /** Kuyruğun görünür hâli: koşan (varsa) + bekleyenler, sıra ile. */
  async list(
    roomId: string,
    agentName: string,
  ): Promise<{ running: QueueEntry | null; queued: QueueEntry[] }> {
    const res = await this.pool.query<Row>(
      `SELECT ${SELECT_COLS} FROM agent_queue q JOIN users u ON u.id = q.user_id
        WHERE q.room_id = $1 AND q.agent_name = $2 AND q.status IN ('queued','running')
        ORDER BY ${FIFO}`,
      [roomId, agentName],
    );
    const rows = res.rows.map(toEntry);
    return {
      running: rows.find((r) => r.status === "running") ?? null,
      queued: rows.filter((r) => r.status === "queued"),
    };
  }

  // --- zamanlayıcı --------------------------------------------------------

  /**
   * Zamanlayıcının kalbi: agent boşsa sıradakini al ve çalıştır.
   *
   * Agent başına tek zincir — iki eşzamanlı `tick` aynı satırı seçip iki
   * mesajı paralel inference'a sokamaz.
   */
  tick(roomId: string, agentName: string): Promise<void> {
    const key = this.key(roomId, agentName);
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(() => this.tickOnce(roomId, agentName))
      .catch((err) => this.log("error", `kuyruk tick hatası (${key}): ${String(err)}`));
    this.chains.set(key, next);
    return next;
  }

  private async tickOnce(roomId: string, agentName: string): Promise<void> {
    const client = await this.pool.connect();
    let picked: Row | null = null;
    try {
      await client.query("BEGIN");

      /**
       * Agent meşgulse hiçbir şey yapma. Bu kontrol ile aşağıdaki seçim AYNI
       * transaction içinde: arada başka bir seçici araya giremez.
       */
      const running = await client.query(
        `SELECT 1 FROM agent_queue
          WHERE room_id = $1 AND agent_name = $2 AND status = 'running' LIMIT 1`,
        [roomId, agentName],
      );
      if ((running.rowCount ?? 0) > 0) {
        await client.query("ROLLBACK");
        return;
      }

      const next = await client.query<Row>(
        `SELECT ${SELECT_COLS} FROM agent_queue q JOIN users u ON u.id = q.user_id
          WHERE q.room_id = $1 AND q.agent_name = $2 AND q.status = 'queued'
          ORDER BY ${FIFO}
          LIMIT 1
          FOR UPDATE OF q SKIP LOCKED`,
        [roomId, agentName],
      );
      const row = next.rows[0];
      if (!row) {
        await client.query("ROLLBACK");
        return;
      }

      await client.query(
        `UPDATE agent_queue SET status = 'running', started_at = now() WHERE id = $1`,
        [row.id],
      );
      await client.query("COMMIT");
      picked = row;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    /**
     * Event yazımı ve runner'a gönderim transaction DIŞINDA: DB kilidini
     * agent'ın ayağa kalkmasını beklerken tutmak bütün kuyruğu dondurur.
     */
    const entry = toEntry(picked);
    try {
      await this.deliverer.deliverQueued(roomId, agentName, {
        messageId: entry.messageId,
        text: entry.text,
        user: entry.user,
      });
    } catch (err) {
      this.log("error", `mesaj agent'a verilemedi (${agentName}): ${String(err)}`);
      /**
       * Agent ayağa kalkamadı. Satırı `running` bırakmak kuyruğu sonsuza
       * kadar tıkar; sessizce beklemek kullanıcıya yalan söyler.
       */
      await this.cancelRow(picked, null, "agent_failed").catch(() => undefined);
      await this.cancelAllQueued(roomId, agentName, "agent_failed").catch(() => undefined);
    }
  }

  // --- turn bitişleri -----------------------------------------------------

  /**
   * Turn bitti (başarılı ya da değil). Satır kapanır ve kuyruk AKMAYA DEVAM
   * EDER: başarısız bir turn kuyruğu durdurmaz.
   */
  async finishRunning(roomId: string, agentName: string, messageId: string): Promise<void> {
    await this.pool.query(
      `UPDATE agent_queue SET status = 'done', finished_at = now()
        WHERE message_id = $1 AND status = 'running'`,
      [messageId],
    );
    await this.tick(roomId, agentName);
  }

  /** Agent kurtarılamadı: bekleyen her şey iptal. Sessiz kuyruk yalan söyler. */
  async agentFailed(roomId: string, agentName: string): Promise<number> {
    return this.cancelAllQueued(roomId, agentName, "agent_failed");
  }

  // --- iptal ---------------------------------------------------------------

  /**
   * Kuyruk kaydını iptal et.
   *
   * Kendi kaydını herkes iptal eder; başkasınınkini yalnızca SÜRÜCÜ veya oda
   * SAHİBİ. Koşan mesaj iptal EDİLMEZ — o kesmedir, `409` ile yönlendirilir.
   */
  async cancel(
    roomId: string,
    messageId: string,
    by: QueueUser,
    perms: { isDriver: boolean; isOwner: boolean },
  ): Promise<{ agentName: string }> {
    const res = await this.pool.query<Row>(
      `SELECT ${SELECT_COLS} FROM agent_queue q JOIN users u ON u.id = q.user_id
        WHERE q.room_id = $1 AND q.message_id = $2`,
      [roomId, messageId],
    );
    const row = res.rows[0];
    if (!row) throw new QueueError(404, "kuyrukta böyle bir kayıt yok");

    if (row.status === "running") {
      throw new QueueError(409, "bu mesaj çalışıyor — iptal değil kesme gerekir", {
        interrupt: `/rooms/${roomId}/agents/${row.agent_name}/interrupt`,
      });
    }
    if (row.status !== "queued") throw new QueueError(409, `kayıt zaten ${row.status}`);

    const mine = row.user_id === by.id;
    if (!mine && !perms.isDriver && !perms.isOwner) {
      // Yetki SUNUCUDA: düğmeyi gizlemek yetki değildir.
      throw new QueueError(403, "başkasının kuyruk kaydını iptal edemezsin");
    }

    await this.cancelRow(row, by, mine ? "user" : "driver");
    return { agentName: row.agent_name };
  }

  private async cancelRow(
    row: Row,
    by: QueueUser | null,
    reason: "user" | "driver" | "server_restart" | "agent_failed",
  ): Promise<void> {
    const res = await this.pool.query(
      `UPDATE agent_queue SET status = 'cancelled', finished_at = now()
        WHERE id = $1 AND status IN ('queued','running')`,
      [row.id],
    );
    // Yarışı yut: iki kişi aynı anda iptal ederse event İKİ KEZ yazılmaz.
    if (!res.rowCount) return;

    await appendEvent(
      {
        roomId: row.room_id,
        sessionId: await this.sessionId(row.room_id),
        // İnsan yoksa actor `system`: iptali kimse yapmadıysa kimseyi yazmayız.
        actor: by ? { kind: "human", id: by.id, name: by.name } : { kind: "system" },
        type: "message.cancelled",
        payload: {
          agent: row.agent_name,
          messageId: row.message_id,
          by: by ? { id: by.id, name: by.name } : null,
          reason,
        },
      } satisfies NewRoomEvent,
      this.pool,
    );
  }

  private async cancelAllQueued(
    roomId: string,
    agentName: string,
    reason: "server_restart" | "agent_failed",
  ): Promise<number> {
    const res = await this.pool.query<Row>(
      `SELECT ${SELECT_COLS} FROM agent_queue q JOIN users u ON u.id = q.user_id
        WHERE q.room_id = $1 AND q.agent_name = $2 AND q.status = 'queued'
        ORDER BY ${FIFO}`,
      [roomId, agentName],
    );
    for (const row of res.rows) await this.cancelRow(row, null, reason);
    return res.rows.length;
  }

  // --- kesme ---------------------------------------------------------------

  /**
   * Koşan turn'ü kes. Yetki (yalnızca sürücü) ÇAĞIRAN KATMANDA kontrol edilir.
   *
   * Koşan turn yoksa `409`: kesilecek bir şey yokken "kestim" demek kullanıcıya
   * yalan söylemek olur.
   */
  async interruptRunning(roomId: string, agentName: string, by: QueueUser): Promise<string> {
    const res = await this.pool.query<{ message_id: string }>(
      `SELECT message_id FROM agent_queue
        WHERE room_id = $1 AND agent_name = $2 AND status = 'running' LIMIT 1`,
      [roomId, agentName],
    );
    const messageId = res.rows[0]?.message_id;
    if (!messageId) throw new QueueError(409, "koşan bir turn yok");

    await this.deliverer.requestInterrupt(roomId, agentName, { messageId, by });
    return messageId;
  }

  // --- açılış mutabakatı ---------------------------------------------------

  /**
   * Sunucu yeniden başladı.
   *
   * `running` satırlar iptal edilir (reason `server_restart`) ve YENİDEN
   * KOŞTURULMAZ: agent işin yarısını yapmış olabilir, tekrar koşmak yan
   * etkiyi ikiye katlar (Hafta 2'den gelen kural).
   *
   * `queued` satırlar KORUNUR ve akmaya devam eder — kuyruğun DB'de olmasının
   * bütün sebebi bu.
   */
  async reconcileOnBoot(): Promise<{ cancelled: number; resumed: number }> {
    const stuck = await this.pool.query<Row>(
      `SELECT ${SELECT_COLS} FROM agent_queue q JOIN users u ON u.id = q.user_id
        WHERE q.status = 'running'`,
    );
    for (const row of stuck.rows) {
      await this.cancelRow(row, null, "server_restart").catch(() => undefined);
    }

    const pending = await this.pool.query<{ room_id: string; agent_name: string }>(
      `SELECT DISTINCT room_id, agent_name FROM agent_queue WHERE status = 'queued'`,
    );
    for (const row of pending.rows) void this.tick(row.room_id, row.agent_name);

    return { cancelled: stuck.rows.length, resumed: pending.rows.length };
  }

  /** Testler ve kapanış: bekleyen zincirlerin bitmesini bekle. */
  async drain(): Promise<void> {
    await Promise.all([...this.chains.values()].map((p) => p.catch(() => undefined)));
  }
}
