import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { RoomConfig } from "@agent-rooms/protocol";
import { getPool } from "../db/pool.js";

export interface RoomRecord {
  id: string;
  name: string;
  repoUrl: string | null;
  configDigest: string;
  createdAt: string;
}

export interface SessionRecord {
  id: string;
  roomId: string;
  containerId: string | null;
  status: "starting" | "running" | "ended";
  startedAt: string;
}

export async function createRoom(
  config: RoomConfig,
  configDigest: string,
  pool: pg.Pool = getPool(),
): Promise<RoomRecord> {
  const id = randomUUID();
  const res = await pool.query<{ created_at: Date }>(
    `INSERT INTO rooms (id, name, repo_url, base_branch, config, config_digest)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     RETURNING created_at`,
    [id, config.name, config.repoUrl, config.baseBranch, JSON.stringify(config), configDigest],
  );
  return {
    id,
    name: config.name,
    repoUrl: config.repoUrl,
    configDigest,
    createdAt: res.rows[0]!.created_at.toISOString(),
  };
}

export async function createSession(
  roomId: string,
  pool: pg.Pool = getPool(),
): Promise<SessionRecord> {
  const id = randomUUID();
  const res = await pool.query<{ started_at: Date }>(
    `INSERT INTO sessions (id, room_id, status)
     VALUES ($1, $2, 'starting')
     RETURNING started_at`,
    [id, roomId],
  );
  return {
    id,
    roomId,
    containerId: null,
    status: "starting",
    startedAt: res.rows[0]!.started_at.toISOString(),
  };
}

export async function attachContainer(
  sessionId: string,
  containerId: string,
  pool: pg.Pool = getPool(),
): Promise<void> {
  await pool.query(
    `UPDATE sessions SET container_id = $2, status = 'running' WHERE id = $1`,
    [sessionId, containerId],
  );
}

export async function endSession(
  sessionId: string,
  pool: pg.Pool = getPool(),
): Promise<void> {
  await pool.query(
    `UPDATE sessions SET status = 'ended', ended_at = now() WHERE id = $1`,
    [sessionId],
  );
}

export async function getRoom(
  roomId: string,
  pool: pg.Pool = getPool(),
): Promise<RoomRecord | null> {
  const res = await pool.query<{
    id: string;
    name: string;
    repo_url: string | null;
    config_digest: string;
    created_at: Date;
  }>(`SELECT id, name, repo_url, config_digest, created_at FROM rooms WHERE id = $1`, [roomId]);
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    repoUrl: row.repo_url,
    configDigest: row.config_digest,
    createdAt: row.created_at.toISOString(),
  };
}

/** Odanın en son oturumu. `since=N` okuması ve kapatma bunun üzerinden gider. */
export async function latestSession(
  roomId: string,
  pool: pg.Pool = getPool(),
): Promise<SessionRecord | null> {
  const res = await pool.query<{
    id: string;
    room_id: string;
    container_id: string | null;
    status: "starting" | "running" | "ended";
    started_at: Date;
  }>(
    `SELECT id, room_id, container_id, status, started_at
       FROM sessions
      WHERE room_id = $1
      ORDER BY started_at DESC
      LIMIT 1`,
    [roomId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    roomId: row.room_id,
    containerId: row.container_id,
    status: row.status,
    startedAt: row.started_at.toISOString(),
  };
}

/** Oda listesi — en yeni önce. Oda silinmez, arşivlenir; hepsi burada durur. */
export async function listRooms(
  limit = 50,
  pool: pg.Pool = getPool(),
): Promise<RoomRecord[]> {
  const res = await pool.query<{
    id: string;
    name: string;
    repo_url: string | null;
    config_digest: string;
    created_at: Date;
  }>(
    `SELECT id, name, repo_url, config_digest, created_at
       FROM rooms
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit],
  );
  return res.rows.map((r) => ({
    id: r.id,
    name: r.name,
    repoUrl: r.repo_url,
    configDigest: r.config_digest,
    createdAt: r.created_at.toISOString(),
  }));
}

/** Odanın açıldığı andaki rol konfigürasyonu — YAML sonradan değişse de bu durur. */
export async function getRoomConfig(
  roomId: string,
  pool: pg.Pool = getPool(),
): Promise<RoomConfig | null> {
  const res = await pool.query<{ config: unknown }>(
    `SELECT config FROM rooms WHERE id = $1`,
    [roomId],
  );
  const row = res.rows[0];
  return row ? (row.config as RoomConfig) : null;
}

/** Oturumu kimliğiyle bul. Elle event yazma ucu roomId'yi buradan alır. */
export async function getSession(
  sessionId: string,
  pool: pg.Pool = getPool(),
): Promise<SessionRecord | null> {
  const res = await pool.query<{
    id: string;
    room_id: string;
    container_id: string | null;
    status: "starting" | "running" | "ended";
    started_at: Date;
  }>(
    `SELECT id, room_id, container_id, status, started_at FROM sessions WHERE id = $1`,
    [sessionId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    roomId: row.room_id,
    containerId: row.container_id,
    status: row.status,
    startedAt: row.started_at.toISOString(),
  };
}

export interface RoomOverview {
  id: string;
  name: string;
  createdAt: string;
  agents: string[];
  session: { id: string; status: string; lastSeq: number } | null;
}

/**
 * Oda listesi + son oturumun durumu ve `lastSeq`'i — TEK sorguda.
 *
 * Oda başına ayrı sorgu atmak (N+1) birkaç odada fark ettirmez ama liste
 * sayfası her yenilendiğinde büyür. LATERAL join ile son oturum satır başına
 * bir kez bulunur.
 */
export async function listRoomsOverview(
  limit = 50,
  pool: pg.Pool = getPool(),
): Promise<RoomOverview[]> {
  const res = await pool.query<{
    id: string;
    name: string;
    created_at: Date;
    config: unknown;
    session_id: string | null;
    session_status: string | null;
    last_seq: string;
  }>(
    `SELECT r.id, r.name, r.created_at, r.config,
            s.id     AS session_id,
            s.status AS session_status,
            COALESCE(MAX(e.seq), 0)::text AS last_seq
       FROM rooms r
       LEFT JOIN LATERAL (
            SELECT id, status FROM sessions
             WHERE room_id = r.id
             ORDER BY started_at DESC
             LIMIT 1
       ) s ON true
       LEFT JOIN session_events e ON e.session_id = s.id
      GROUP BY r.id, r.name, r.created_at, r.config, s.id, s.status
      ORDER BY r.created_at DESC
      LIMIT $1`,
    [limit],
  );

  return res.rows.map((r) => {
    const cfg = r.config as RoomConfig | null;
    return {
      id: r.id,
      name: r.name,
      createdAt: r.created_at.toISOString(),
      // Agent sayısı sabit değil: her zaman config dizisinden.
      agents: cfg?.agents?.map((a) => a.name) ?? [],
      session: r.session_id
        ? {
            id: r.session_id,
            status: r.session_status ?? "unknown",
            lastSeq: Number(r.last_seq),
          }
        : null,
    };
  });
}
