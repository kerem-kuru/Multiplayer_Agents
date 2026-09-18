import type pg from "pg";
import {
  NewRoomEvent as NewRoomEventSchema,
  RoomEvent,
  parseEvent,
  type NewRoomEvent,
} from "@agent-rooms/protocol";
import type { Finding } from "@agent-rooms/redact";
import { getEventBus } from "../bus.js";
import { noteEventForSnapshot } from "../snapshot.js";
import { redactEventPayload } from "../redaction.js";
import { getPool, withTx } from "./pool.js";

/**
 * Append-only event store.
 *
 * `seq` oturum başına tek bir satır kilidi üzerinden dağıtılır
 * (`sessions.next_seq`), böylece iki paralel yazıcı aynı sırayı alamaz.
 * `(session_id, seq)` üzerindeki unique index son savunma hattıdır.
 *
 * REDACTION TEK GEÇİT: temizleme burada, YAZMADAN ÖNCE yapılır. Görüntüleme
 * anına bırakılsaydı secret veritabanında, yedeklerde, replay'de ve denetim
 * çıktısında dururdu — append-only bir log'dan sonradan silmek mümkün değil.
 * Bu yüzden `INSERT INTO session_events` başka hiçbir yerde yazılmaz.
 */

export interface AppendResult {
  seq: number;
  ts: string;
}

async function appendOne(
  client: pg.PoolClient,
  event: NewRoomEvent,
): Promise<RoomEvent> {
  // Şemadan geçmeyen hiçbir şey log'a giremez.
  const parsed = NewRoomEventSchema.parse(event) as NewRoomEvent;

  // ...ve temizlenmemiş hiçbir şey. Bundan sonrası SADECE temiz veriyle çalışır.
  const cleaned = redactEventPayload(parsed.roomId, parsed.payload);
  const validated = { ...parsed, payload: cleaned.payload } as NewRoomEvent;

  const seqRow = await client.query<{ seq: string }>(
    `UPDATE sessions
        SET next_seq = next_seq + 1
      WHERE id = $1
      RETURNING (next_seq - 1)::text AS seq`,
    [validated.sessionId],
  );
  if (seqRow.rowCount === 0) {
    throw new Error(`oturum bulunamadı: ${validated.sessionId}`);
  }
  const seq = Number(seqRow.rows[0]!.seq);

  const inserted = await client.query<{ ts: Date }>(
    `INSERT INTO session_events (room_id, session_id, seq, type, actor, payload)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
     RETURNING ts`,
    [
      validated.roomId,
      validated.sessionId,
      seq,
      validated.type,
      JSON.stringify(validated.actor),
      JSON.stringify(validated.payload),
    ],
  );

  await writeFindings(client, validated.sessionId, seq, cleaned.findings);

  return parseEvent({
    ...validated,
    seq,
    ts: inserted.rows[0]!.ts.toISOString(),
  });
}

/**
 * Bulgu kaydı — AYNI transaction'da. Event yazılıp bulgusu yazılmadan çökerse
 * "burada bir secret vardı" bilgisi kaybolur.
 *
 * Kayıt ASLA ham secret içermez: kural adı, payload içindeki yol, uzunluk ve
 * sha256'nın ilk 8 hex'i.
 */
async function writeFindings(
  client: pg.PoolClient,
  sessionId: string,
  seq: number,
  findings: readonly Finding[],
): Promise<void> {
  if (findings.length === 0) return;

  // Satır başına dört alan; ilk iki parametre (session, seq) ortak.
  const params: unknown[] = [sessionId, seq];
  const placeholders = findings.map((f, i) => {
    const b = 2 + i * 4;
    params.push(f.rule, f.path, f.hash8, f.length);
    return `($1, $2, $${b + 1}, $${b + 2}, $${b + 3}, $${b + 4})`;
  });

  await client.query(
    `INSERT INTO redaction_findings (session_id, seq, rule, path, hash8, length)
     VALUES ${placeholders.join(", ")}`,
    params,
  );
}

/**
 * Tek event yaz.
 *
 * Yayın COMMIT'TEN SONRA yapılır: önce yayınlamak, UI'da veritabanında
 * olmayan bir event göstermek demektir. Rollback olursa kimse duymaz.
 */
export async function appendEvent(
  event: NewRoomEvent,
  pool: pg.Pool = getPool(),
): Promise<RoomEvent> {
  const stored = await withTx((client) => appendOne(client, event), pool);
  getEventBus().publish(stored.sessionId, stored);
  noteEventForSnapshot(stored.sessionId, stored.seq);
  return stored;
}

/** Birden çok event'i tek transaction'da, verilen sırayla yaz. */
export async function appendEvents(
  events: NewRoomEvent[],
  pool: pg.Pool = getPool(),
): Promise<RoomEvent[]> {
  const stored = await withTx(async (client) => {
    const out: RoomEvent[] = [];
    for (const e of events) out.push(await appendOne(client, e));
    return out;
  }, pool);
  // Hepsi tek commit'te yazıldı; yayın da commit'ten sonra, sırayla.
  const bus = getEventBus();
  for (const e of stored) bus.publish(e.sessionId, e);
  const last = stored[stored.length - 1];
  if (last) noteEventForSnapshot(last.sessionId, last.seq);
  return stored;
}

export interface ReadOptions {
  /** Bu sıradan SONRAKİ event'ler. Yeniden bağlanan istemci boşluğu böyle doldurur. */
  since?: number;
  limit?: number;
}

/** Oturumun event'lerini sırayla oku. */
export async function readEvents(
  sessionId: string,
  { since = 0, limit = 500 }: ReadOptions = {},
  pool: pg.Pool = getPool(),
): Promise<RoomEvent[]> {
  const res = await pool.query<{
    seq: string;
    room_id: string;
    session_id: string;
    ts: Date;
    type: string;
    actor: unknown;
    payload: unknown;
  }>(
    `SELECT seq, room_id, session_id, ts, type, actor, payload
       FROM session_events
      WHERE session_id = $1 AND seq > $2
      ORDER BY seq ASC
      LIMIT $3`,
    [sessionId, since, limit],
  );

  return res.rows.map((r) =>
    parseEvent({
      seq: Number(r.seq),
      roomId: r.room_id,
      sessionId: r.session_id,
      ts: r.ts.toISOString(),
      type: r.type,
      actor: r.actor,
      payload: r.payload,
    }),
  );
}

/** Oturumdaki son sıra numarası. 0 = hiç event yok. */
export async function latestSeq(
  sessionId: string,
  pool: pg.Pool = getPool(),
): Promise<number> {
  const res = await pool.query<{ seq: string | null }>(
    `SELECT MAX(seq)::text AS seq FROM session_events WHERE session_id = $1`,
    [sessionId],
  );
  return Number(res.rows[0]?.seq ?? 0);
}
