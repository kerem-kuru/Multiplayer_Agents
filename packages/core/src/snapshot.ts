import type pg from "pg";
import type { StoredEvent } from "@agent-rooms/protocol";
import { SNAPSHOT_VERSION, project, type RoomView } from "@agent-rooms/view";
import { readEvents } from "./db/eventStore.js";
import { getPool } from "./db/pool.js";

/**
 * Snapshot — yeni katılanın `since=0`'dan replay yapmaması için.
 *
 * Odaya davet linkiyle giren biri 10 000 event'lik bir geçmişi baştan
 * indirmemeli: en güncel snapshot'ı alır, sonrasını SSE ile sürdürür.
 *
 * DOĞRULUK ŞARTI: `project(tüm event'ler)` ile `snapshot.state + sonrası`
 * DERİN EŞİT olmalı. Eşit değilse hata snapshot'ta değil projeksiyondadır
 * (saf değildir) — snapshot'ı düzeltmek sorunu gizler.
 */

/** Bu kadar event biriktiyse üret. */
export const SNAPSHOT_EVERY_EVENTS = 200;
/** Ya da bu kadar süre geçtiyse (ve en az 1 yeni event varsa). */
export const SNAPSHOT_EVERY_MS = 60_000;
/** Session başına saklanan snapshot sayısı. */
export const SNAPSHOT_KEEP = 3;

export interface StoredSnapshot {
  seq: number;
  version: number;
  state: RoomView;
}

/** Okunabilir EN GÜNCEL snapshot. Sürümü eskiyse yok sayılır. */
export async function latestSnapshot(
  sessionId: string,
  pool: pg.Pool = getPool(),
): Promise<StoredSnapshot | null> {
  const res = await pool.query<{ seq: string; version: number; state: RoomView }>(
    `SELECT seq, version, state
       FROM snapshots
      WHERE session_id = $1 AND version = $2
      ORDER BY seq DESC
      LIMIT 1`,
    [sessionId, SNAPSHOT_VERSION],
  );
  const row = res.rows[0];
  return row ? { seq: Number(row.seq), version: row.version, state: row.state } : null;
}

/**
 * Session'ın güncel görünümü: snapshot varsa onun üzerine sonrasını uygular,
 * yoksa baştan kurar. Sunucu tarafında "şu an ne görünüyor" sorusunun cevabı.
 */
export async function currentView(
  sessionId: string,
  pool: pg.Pool = getPool(),
): Promise<{ view: RoomView; fromSnapshot: boolean }> {
  const snapshot = await latestSnapshot(sessionId, pool);
  const since = snapshot?.seq ?? 0;
  const events = await readAllEvents(sessionId, since, pool);
  return {
    view: project(events, snapshot?.state),
    fromSnapshot: snapshot !== null,
  };
}

/** Sayfalayarak hepsini oku — `readEvents` tek çağrıda 500 ile sınırlı. */
async function readAllEvents(
  sessionId: string,
  since: number,
  pool: pg.Pool,
): Promise<StoredEvent[]> {
  const out: StoredEvent[] = [];
  let cursor = since;
  for (;;) {
    const page = await readEvents(sessionId, { since: cursor, limit: 500 }, pool);
    if (page.length === 0) break;
    out.push(...(page as StoredEvent[]));
    cursor = page[page.length - 1]!.seq;
    if (page.length < 500) break;
  }
  return out;
}

/** Üretim tetiklendi mi — son snapshot'tan bu yana event ve süre. */
export function shouldSnapshot(args: {
  lastSnapshotSeq: number;
  lastSnapshotAt: number | null;
  latestSeq: number;
  now: number;
}): boolean {
  const newEvents = args.latestSeq - args.lastSnapshotSeq;
  if (newEvents <= 0) return false;
  if (newEvents >= SNAPSHOT_EVERY_EVENTS) return true;
  if (args.lastSnapshotAt === null) return false;
  return args.now - args.lastSnapshotAt >= SNAPSHOT_EVERY_MS;
}

/**
 * Snapshot üret ve yaz. Aynı session için ikinci bir üretim başlamaz:
 * projeksiyon saf ama okuma + yazma arası yarış üretebilir.
 */
const inFlight = new Set<string>();

export async function writeSnapshot(
  sessionId: string,
  pool: pg.Pool = getPool(),
): Promise<StoredSnapshot | null> {
  if (inFlight.has(sessionId)) return null;
  inFlight.add(sessionId);
  try {
    const snapshot = await latestSnapshot(sessionId, pool);
    const events = await readAllEvents(sessionId, snapshot?.seq ?? 0, pool);
    if (events.length === 0) return null;

    const state = project(events, snapshot?.state);
    await pool.query(
      `INSERT INTO snapshots (session_id, seq, version, state)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (session_id, seq) DO NOTHING`,
      [sessionId, state.lastSeq, SNAPSHOT_VERSION, JSON.stringify(state)],
    );

    // Session başına son 3 tanesi kalsın: eskiler kimseye lazım değil.
    await pool.query(
      `DELETE FROM snapshots
        WHERE session_id = $1
          AND seq NOT IN (
            SELECT seq FROM snapshots WHERE session_id = $1 ORDER BY seq DESC LIMIT $2
          )`,
      [sessionId, SNAPSHOT_KEEP],
    );

    return { seq: state.lastSeq, version: SNAPSHOT_VERSION, state };
  } finally {
    inFlight.delete(sessionId);
  }
}

/**
 * Zamanlayıcı — session başına TEK.
 *
 * `appendEvent` her yazımdan sonra buraya haber veriyor. İki tetik var:
 * 200 event (hemen) veya 60 saniye (zamanlayıcıyla, en az 1 yeni event varsa).
 * Timer `unref` edilir: snapshot üretimi sunucunun kapanmasını geciktirmemeli.
 */
interface SchedulerEntry {
  lastSeq: number;
  lastSnapshotSeq: number;
  lastSnapshotAt: number | null;
  timer: NodeJS.Timeout | null;
}

const scheduler = new Map<string, SchedulerEntry>();
let schedulerEnabled = true;
let onError: (err: unknown) => void = () => undefined;

export function configureSnapshots(options: {
  enabled?: boolean;
  onError?: (err: unknown) => void;
}): void {
  if (options.enabled !== undefined) schedulerEnabled = options.enabled;
  if (options.onError) onError = options.onError;
}

export function noteEventForSnapshot(sessionId: string, seq: number): void {
  if (!schedulerEnabled) return;

  let entry = scheduler.get(sessionId);
  if (!entry) {
    entry = { lastSeq: seq, lastSnapshotSeq: 0, lastSnapshotAt: null, timer: null };
    scheduler.set(sessionId, entry);
  }
  entry.lastSeq = Math.max(entry.lastSeq, seq);

  if (entry.lastSeq - entry.lastSnapshotSeq >= SNAPSHOT_EVERY_EVENTS) {
    void runSnapshot(sessionId, entry);
    return;
  }
  if (entry.timer) return;

  entry.timer = setTimeout(() => {
    entry.timer = null;
    if (entry.lastSeq > entry.lastSnapshotSeq) void runSnapshot(sessionId, entry);
  }, SNAPSHOT_EVERY_MS);
  entry.timer.unref?.();
}

async function runSnapshot(sessionId: string, entry: SchedulerEntry): Promise<void> {
  try {
    const written = await writeSnapshot(sessionId);
    if (written) {
      entry.lastSnapshotSeq = written.seq;
      entry.lastSnapshotAt = Date.now();
    }
  } catch (err) {
    // Snapshot bir hızlandırmadır; üretilemezse tam replay yolu çalışmaya
    // devam eder. Yazma yolunu ASLA düşürmemeli.
    onError(err);
  }
}

/** Test ve kapanış için: bekleyen zamanlayıcıları bırak. */
export function resetSnapshotScheduler(): void {
  for (const entry of scheduler.values()) if (entry.timer) clearTimeout(entry.timer);
  scheduler.clear();
}
