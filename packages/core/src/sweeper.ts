import type pg from "pg";
import { getPool } from "./db/pool.js";
import {
  ROOM_LABEL,
  listRoomContainers,
  listRoomVolumes,
  removeRoomVolume,
  stopRoomContainer,
} from "./docker/container.js";


/**
 * Hafta 7, Adım 10 — sahipsiz container ve volume temizliği.
 *
 * Sunucu açılışında ve saatte bir koşar. İki yönlü mutabakat:
 *
 *   1. Docker'da var, DB'de `running` bir odaya karşılık yok  → sil
 *   2. DB'de `running`, Docker'da container yok               → `failed` yap
 *
 * **Event log'a YAZILMAZ.** Silinen oda artık yok; olmayan bir odanın
 * oturumuna event yazmak, log'da karşılığı olmayan bir satır bırakırdı.
 * Sunucu loguna yazılır.
 *
 * Volume'lar container'dan uzun yaşadığı için ayrıca taranıyor: container
 * silinip volume kalsaydı disk sessizce dolardı.
 *
 * Core doğrudan `console`a yazmaz (log'un nereye gideceği API katmanının
 * kararı); satırlar `notify` geri çağrısıyla dışarı veriliyor.
 */

/** Sunucu loguna gidecek tek satır. */
export type SweepNotice = (level: "info" | "warn", message: string) => void;

const silent: SweepNotice = () => undefined;

export interface SweepResult {
  removedContainers: string[];
  removedVolumes: string[];
  failedRooms: string[];
}

/** DB'de hâlâ yaşayan (silinmemiş) odaların kimlikleri. */
async function liveRoomIds(pool: pg.Pool): Promise<Set<string>> {
  const res = await pool.query<{ id: string }>(
    `SELECT id FROM rooms WHERE status IN ('creating', 'running')`,
  );
  return new Set(res.rows.map((r) => r.id));
}

export async function sweepOrphans(
  pool: pg.Pool = getPool(),
  notify: SweepNotice = silent,
): Promise<SweepResult> {
  const out: SweepResult = { removedContainers: [], removedVolumes: [], failedRooms: [] };
  const live = await liveRoomIds(pool);

  // --- 1a. sahipsiz container'lar -----------------------------------------
  const containers = await listRoomContainers();
  const seenRooms = new Set<string>();
  for (const c of containers) {
    const roomId = (c.Labels ?? {})[ROOM_LABEL];
    if (!roomId) continue;
    seenRooms.add(roomId);
    if (live.has(roomId)) continue;
    const name = c.Names?.[0]?.replace(/^\//, "") ?? c.Id;
    await stopRoomContainer(c.Id).catch(() => undefined);
    out.removedContainers.push(name);
    notify("info", `sweeper: sahipsiz container silindi — ${name} (oda ${roomId})`);
  }

  // --- 1b. sahipsiz volume'lar --------------------------------------------
  for (const v of await listRoomVolumes()) {
    if (live.has(v.roomId)) continue;
    await removeRoomVolume(v.roomId).catch(() => undefined);
    out.removedVolumes.push(v.name);
    notify("info", `sweeper: sahipsiz volume silindi — ${v.name} (oda ${v.roomId})`);
  }

  /*
   * --- 2. DB'de running, Docker'da yok ------------------------------------
   *
   * En sık sebebi Docker'ın yeniden başlaması ya da elle `docker rm`. Oda
   * `failed`a çekiliyor; arayüz "oda kapandı, yeni oda aç" diyebilsin.
   * Agent mutabakatı (Hafta 2) ayrıca runtime satırlarını `stopped`a çekiyor.
   */
  for (const roomId of live) {
    if (seenRooms.has(roomId)) continue;
    await pool.query(`UPDATE rooms SET status = 'failed' WHERE id = $1`, [roomId]);
    out.failedRooms.push(roomId);
    notify("warn", `sweeper: oda container'ı yok, 'failed' işaretlendi — ${roomId}`);
  }

  return out;
}

/** Saatte bir. Sunucu açılışında bir kez de elle çağrılır. */
export function startSweeper(
  intervalMs = 3_600_000,
  pool: pg.Pool = getPool(),
  notify: SweepNotice = silent,
): () => void {
  const timer = setInterval(() => {
    sweepOrphans(pool, notify).catch((err) => notify("warn", `sweeper düştü: ${String(err)}`));
  }, intervalMs);
  // Süreç kapanışını BEKLETMESİN.
  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * Odayı arşivler: container ve volume silinir, DB kaydı ve event log DURUR.
 *
 * Append-only kuralı: `session_events` ve `rooms` satırları SİLİNMEZ. Odanın
 * tarihi okunmaya devam eder; giden şey yalnızca çalışan altyapı.
 *
 * Merkezdeki branch'ler volume ile birlikte gidiyor. Bu hafta birleştirme
 * olmadığı için kaybedilecek iş yok; Hafta 10'da silme öncesi dışa aktarma
 * eklenecek.
 */
export async function archiveRoom(
  roomId: string,
  pool: pg.Pool = getPool(),
  notify: SweepNotice = silent,
): Promise<void> {
  for (const c of await listRoomContainers(roomId)) {
    await stopRoomContainer(c.Id).catch(() => undefined);
  }
  await removeRoomVolume(roomId).catch(() => undefined);
  await pool.query(`UPDATE rooms SET status = 'archived' WHERE id = $1`, [roomId]);
  notify("info", `oda arşivlendi: ${roomId} — container ve volume silindi, event log duruyor`);
}
