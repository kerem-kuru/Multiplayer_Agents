import type pg from "pg";
import { getPool } from "./db/pool.js";

/**
 * Hafta 7, Adım 12 — okunmamış takibi.
 *
 * **Event log'a YAZILMAZ.** "Kerem bu agent'ı gördü" odanın ortak tarihi değil,
 * o kullanıcıya özel bir durum. Event log'a yazsaydık iki kişilik bir odada
 * log'un yarısı okuma işaretleri olurdu ve projeksiyon her yeniden kurulduğunda
 * bunları da işlemek zorunda kalırdı.
 *
 * Okunmamış hesabı kartta yapılıyor: agent'ın DİKKAT GEREKTİREN son event'inin
 * sırası, bu kullanıcının `last_seen_seq` değerinden büyükse okunmamış.
 */

/** Bu kullanıcının odadaki tüm agent'lar için gördüğü son sıra. */
export async function readMarks(
  userId: string,
  roomId: string,
  pool: pg.Pool = getPool(),
): Promise<Record<string, number>> {
  const res = await pool.query<{ agent_name: string; last_seen_seq: string }>(
    `SELECT agent_name, last_seen_seq FROM agent_reads WHERE user_id = $1 AND room_id = $2`,
    [userId, roomId],
  );
  const out: Record<string, number> = {};
  for (const r of res.rows) out[r.agent_name] = Number(r.last_seen_seq);
  return out;
}

/**
 * Görülen sırayı ilerletir. **Değer GERİYE GİTMEZ.**
 *
 * Geri gidebilseydi: iki sekme açık olan bir kullanıcıda eski sekmenin geç
 * gelen `seen` çağrısı, yeni sekmede okunmuş olan her şeyi tekrar okunmamış
 * yapardı. `GREATEST` bunu veritabanı seviyesinde çözüyor — iki isteğin
 * sırasına bağlı değil.
 */
export async function markSeen(
  userId: string,
  roomId: string,
  agentName: string,
  seq: number,
  pool: pg.Pool = getPool(),
): Promise<number> {
  const res = await pool.query<{ last_seen_seq: string }>(
    `INSERT INTO agent_reads (user_id, room_id, agent_name, last_seen_seq)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, room_id, agent_name)
     DO UPDATE SET last_seen_seq = GREATEST(agent_reads.last_seen_seq, EXCLUDED.last_seen_seq),
                   updated_at = now()
     RETURNING last_seen_seq`,
    [userId, roomId, agentName, Math.max(0, Math.floor(seq))],
  );
  return Number(res.rows[0]?.last_seen_seq ?? 0);
}
