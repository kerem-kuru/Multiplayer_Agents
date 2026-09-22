import type pg from "pg";
import { getPool } from "../db/pool.js";

/**
 * Agent çalışma durumu — `agent_runtime` tablosunun projeksiyonu.
 *
 * Durum makinesi burada kodla zorlanıyor. Tablodaki CHECK kısıtı geçerli
 * DEĞERLERİ korur; `assertTransition` geçerli GEÇİŞLERİ korur. İkisi farklı
 * şey: `busy` geçerli bir değer ama `stopped → busy` bir kod hatasıdır.
 */

export const AGENT_STATUSES = [
  "stopped",
  "starting",
  "idle",
  "busy",
  "crashed",
  "failed",
] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/** Doküman Adım 8'deki tablo. Dışındaki her geçiş kod hatasıdır. */
const ALLOWED: Record<AgentStatus, readonly AgentStatus[]> = {
  stopped: ["starting"],
  failed: ["starting"],
  // `failed`: ayağa kalkarken kurtarılamaz bir sorun çıktı (ör. odanın
  // container'ı silinmiş). Bu geçiş olmadan runtime sonsuza kadar
  // `starting`de asılı kalıyordu ve ekranda hiçbir açıklama görünmüyordu.
  starting: ["idle", "stopped", "crashed", "failed"],
  idle: ["busy", "stopped", "crashed"],
  busy: ["idle", "stopped", "crashed"],
  crashed: ["starting", "failed"],
};

export class TransitionError extends Error {
  constructor(
    readonly from: AgentStatus,
    readonly to: AgentStatus,
  ) {
    super(`geçersiz durum geçişi: ${from} → ${to}`);
    this.name = "TransitionError";
  }
}

export function canTransition(from: AgentStatus, to: AgentStatus): boolean {
  return ALLOWED[from].includes(to);
}

export function assertTransition(from: AgentStatus, to: AgentStatus): void {
  if (!canTransition(from, to)) throw new TransitionError(from, to);
}

export interface AgentRuntime {
  roomId: string;
  agentName: string;
  status: AgentStatus;
  sdkSessionId: string | null;
  currentMessageId: string | null;
  restartCount: number;
  lastExitCode: number | null;
  lastError: string | null;
  /**
   * Canlı diff tabanı (Hafta 6). null = taban henüz alınmadı; runner canlı
   * diff yayımlamaz. Sessizce yanlış bir tabana göre diff göstermektense hiç
   * göstermemek doğru.
   */
  diffBaseCheckpointId: string | null;
  updatedAt: string;
}

interface Row {
  room_id: string;
  agent_name: string;
  status: AgentStatus;
  sdk_session_id: string | null;
  current_message_id: string | null;
  restart_count: number;
  last_exit_code: number | null;
  last_error: string | null;
  diff_base_checkpoint_id: string | null;
  updated_at: Date;
}

const toRuntime = (r: Row): AgentRuntime => ({
  roomId: r.room_id,
  agentName: r.agent_name,
  status: r.status,
  sdkSessionId: r.sdk_session_id,
  currentMessageId: r.current_message_id,
  restartCount: r.restart_count,
  lastExitCode: r.last_exit_code,
  lastError: r.last_error,
  diffBaseCheckpointId: r.diff_base_checkpoint_id,
  updatedAt: r.updated_at.toISOString(),
});

const COLS = `room_id, agent_name, status, sdk_session_id, current_message_id,
              restart_count, last_exit_code, last_error, diff_base_checkpoint_id,
              updated_at`;

/** Oda açılırken YAML'daki her agent için bir satır. Agent sayısı dizi uzunluğudur. */
export async function ensureRuntimeRows(
  roomId: string,
  agentNames: string[],
  pool: pg.Pool = getPool(),
): Promise<void> {
  if (agentNames.length === 0) return;
  await pool.query(
    `INSERT INTO agent_runtime (room_id, agent_name)
     SELECT $1, unnest($2::text[])
     ON CONFLICT (room_id, agent_name) DO NOTHING`,
    [roomId, agentNames],
  );
}

/**
 * Odadaki agent'ların uid ataması. Hafta 7: uid bir kez atanır ve DEĞİŞMEZ —
 * uid değişmesi, o uid'e ait dosyaların bir anda başka bir agent'ın olması
 * demek.
 */
export async function readUids(
  roomId: string,
  pool: pg.Pool = getPool(),
): Promise<Record<string, number>> {
  const res = await pool.query<{ agent_name: string; uid: number | null }>(
    `SELECT agent_name, uid FROM agent_runtime WHERE room_id = $1`,
    [roomId],
  );
  const out: Record<string, number> = {};
  for (const r of res.rows) {
    if (typeof r.uid === "number") out[r.agent_name] = r.uid;
  }
  return out;
}

/** uid ve branch'i yazar. `agent_runtime_uid` benzersiz indexi ikinci atamayı reddeder. */
export async function writeUids(
  roomId: string,
  uids: Readonly<Record<string, number>>,
  branches: Readonly<Record<string, string>> = {},
  pool: pg.Pool = getPool(),
): Promise<void> {
  for (const [name, uid] of Object.entries(uids)) {
    await pool.query(
      `UPDATE agent_runtime SET uid = $3, branch = COALESCE($4, branch), updated_at = now()
       WHERE room_id = $1 AND agent_name = $2`,
      [roomId, name, uid, branches[name] ?? null],
    );
  }
}

export async function listRuntime(
  roomId: string,
  pool: pg.Pool = getPool(),
): Promise<AgentRuntime[]> {
  const res = await pool.query<Row>(
    `SELECT ${COLS} FROM agent_runtime WHERE room_id = $1 ORDER BY agent_name`,
    [roomId],
  );
  return res.rows.map(toRuntime);
}

export async function getRuntime(
  roomId: string,
  agentName: string,
  pool: pg.Pool = getPool(),
): Promise<AgentRuntime | null> {
  const res = await pool.query<Row>(
    `SELECT ${COLS} FROM agent_runtime WHERE room_id = $1 AND agent_name = $2`,
    [roomId, agentName],
  );
  const row = res.rows[0];
  return row ? toRuntime(row) : null;
}

export interface RuntimePatch {
  sdkSessionId?: string | null;
  currentMessageId?: string | null;
  restartCount?: number;
  lastExitCode?: number | null;
  lastError?: string | null;
}

/**
 * Durumu değiştirir. Geçiş tablosu satır kilidi altında kontrol edilir —
 * iki eşzamanlı yazıcı birbirinin geçişini geçersiz kılamaz.
 */
export async function transition(
  roomId: string,
  agentName: string,
  to: AgentStatus,
  patch: RuntimePatch = {},
  pool: pg.Pool = getPool(),
): Promise<AgentRuntime> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const cur = await client.query<{ status: AgentStatus }>(
      `SELECT status FROM agent_runtime WHERE room_id = $1 AND agent_name = $2 FOR UPDATE`,
      [roomId, agentName],
    );
    const from = cur.rows[0]?.status;
    if (!from) throw new Error(`agent_runtime satırı yok: ${roomId}/${agentName}`);
    assertTransition(from, to);

    const res = await client.query<Row>(
      `UPDATE agent_runtime
          SET status             = $3,
              sdk_session_id     = COALESCE($4, sdk_session_id),
              current_message_id = CASE WHEN $5::boolean THEN $6::uuid ELSE current_message_id END,
              restart_count      = COALESCE($7, restart_count),
              last_exit_code     = CASE WHEN $8::boolean THEN $9::integer ELSE last_exit_code END,
              last_error         = CASE WHEN $10::boolean THEN $11::text ELSE last_error END,
              updated_at         = now()
        WHERE room_id = $1 AND agent_name = $2
        RETURNING ${COLS}`,
      [
        roomId,
        agentName,
        to,
        patch.sdkSessionId ?? null,
        "currentMessageId" in patch,
        patch.currentMessageId ?? null,
        patch.restartCount ?? null,
        "lastExitCode" in patch,
        patch.lastExitCode ?? null,
        "lastError" in patch,
        patch.lastError ?? null,
      ],
    );
    await client.query("COMMIT");
    return toRuntime(res.rows[0]!);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Sunucu açılışında mutabakat gereken satırlar. */
export async function listUnsettled(pool: pg.Pool = getPool()): Promise<AgentRuntime[]> {
  const res = await pool.query<Row>(
    `SELECT ${COLS} FROM agent_runtime
      WHERE status IN ('starting','idle','busy','crashed')
      ORDER BY room_id, agent_name`,
  );
  return res.rows.map(toRuntime);
}

/** Mutabakat: geçiş tablosuna bakmadan doğrudan stopped'a çeker. */
export async function forceStopped(
  roomId: string,
  agentName: string,
  lastError: string | null,
  pool: pg.Pool = getPool(),
): Promise<void> {
  await pool.query(
    `UPDATE agent_runtime
        SET status = 'stopped', current_message_id = NULL, last_error = $3, updated_at = now()
      WHERE room_id = $1 AND agent_name = $2`,
    [roomId, agentName, lastError],
  );
}
