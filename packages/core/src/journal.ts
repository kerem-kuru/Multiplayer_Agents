import type pg from "pg";
import {
  Contract,
  DecisionRecord,
  EMPTY_JOURNAL,
  JOURNAL_LIMITS,
  JournalSnapshot,
  journalErrorFields,
  mergeJournalWrite,
  parseJournalPatch,
  type Actor,
  type JournalPatch,
  type JournalState,
  type NewRoomEvent,
  type RoomConfig,
  type RoomEvent,
} from "@agent-rooms/protocol";
import type { z } from "zod";
import { appendEventUnderLock } from "./db/eventStore.js";
import { getPool } from "./db/pool.js";
import { getRoomConfig, latestSession } from "./room/rooms.js";

/**
 * Oda defteri çekirdeği — Hafta 8, Adım 3.
 *
 * MANTIK TEK YERDE: `write_summary` (RPC), turn sonu özeti ve
 * `POST /rooms/:id/journal` aynı `writeJournalEntry`'yi çağırır.
 *
 * Yazım sırası, tek transaction'da:
 *
 * 1. Oturum satırı kilitlenir — oda düzeyinde sıra. Agent başına kilit
 *    yetmezdi: sözleşme adı oda içinde tek ve sahiplik kontrolü öteki
 *    agent'ların sicilini okur.
 * 2. Kilit altında durum okunur, `mergeJournalWrite` (saf) yazımı kurar.
 *    Reddedilirse hiçbir şey yazılmaz.
 * 3. `journal.entry_written` event'i yazılır; tablolar o event'in
 *    redaction'dan GEÇMİŞ payload'ından yazılır. Görev tanımı event'i commit
 *    sonrasına koyuyordu: o zaman tablo ile log ayrışabilir ve tablolarda
 *    temizlenmemiş secret kalırdı (Değişmez Kural 8; Hafta 6'daki
 *    `appendEventWith` kalıbı).
 *
 * Host alanları buradan gelir, payload'dan değil:
 * - `touched`: bu turn'ün `file.changed`, `diff.updated`, `contract.changed`
 *   yolları, depo-göreli.
 * - `Contract.sourceSha256`: `contracts/` altındaki dosyanın log'daki son
 *   `contract.changed.sha256`'sı. Container'dan dosya OKUNMAZ — sha zaten
 *   log'da ve root ile okuma Hafta 7'de bir delik çıkarmıştı (23 Eylül).
 *   `contracts/` dışındaki dosyalar izlenmiyor: null.
 */

export type JournalSource = "agent" | "auto" | "human";

export interface WriteJournalInput {
  roomId: string;
  /** Host'un bildiği kimlik. Payload'daki `agent` zaten atılıyor. */
  agentName: string;
  /** Hangi turn'de; insan yazımında null. */
  messageId: string | null;
  source: JournalSource;
  /** Doğrulanmamış payload. */
  patch: unknown;
  actor: Actor;
  summaryCostUsd?: number;
}

export type WriteJournalResult =
  | { ok: true; version: number; event: RoomEvent }
  | { ok: false; status: 400 | 404 | 409; fields: string[]; message: string };

type Rejection = Extract<WriteJournalResult, { ok: false }>;

function rejected(error: z.ZodError): Rejection {
  return {
    ok: false,
    status: 400,
    fields: journalErrorFields(error),
    message: error.issues.map((i) => `${i.path.join(".") || "(kayıt)"}: ${i.message}`).join("; "),
  };
}

export async function writeJournalEntry(
  input: WriteJournalInput,
  pool: pg.Pool = getPool(),
): Promise<WriteJournalResult> {
  const config = await getRoomConfig(input.roomId, pool);
  if (!config) return { ok: false, status: 404, fields: [], message: "oda yok" };
  const agent = config.agents.find((a) => a.name === input.agentName);
  if (!agent) return { ok: false, status: 404, fields: [], message: `agent YAML'da yok: ${input.agentName}` };
  const session = await latestSession(input.roomId, pool);
  if (!session) return { ok: false, status: 409, fields: [], message: "odanın oturumu yok" };

  const parsed = parseJournalPatch(input.patch, { agents: config.agents.map((a) => a.name) });
  if (!parsed.success) return rejected(parsed.error);
  const patch: JournalPatch = parsed.data;

  const out = await appendEventUnderLock<Rejection>(
    session.id,
    async (client) => {
      const state = await loadState(client, input.roomId);
      const version = (state.snapshots[input.agentName]?.version ?? 0) + 1;
      const touched = input.messageId
        ? await turnTouched(client, session.id, input.messageId, agent.workspace, config)
        : undefined;
      const shas = await contractShas(client, session.id);
      const fileSha = (file: string) => {
        const rel = contractRelative(file, config);
        return rel === null ? null : (shas.get(rel) ?? null);
      };

      const merged = mergeJournalWrite(state, patch, { agent: input.agentName, version, touched, fileSha });
      if (!merged.success) return { skip: rejected(merged.error) };
      const w = merged.data;

      const event = {
        roomId: input.roomId,
        sessionId: session.id,
        actor: input.actor,
        type: "journal.entry_written",
        payload: {
          agent: input.agentName,
          messageId: input.messageId,
          version,
          source: input.source,
          patch,
          snapshot: w.snapshot,
          decisions: w.decisions,
          contracts: w.contracts,
          removeContracts: w.removeContracts,
          summaryCostUsd: input.summaryCostUsd ?? 0,
        },
      } satisfies NewRoomEvent;

      return { event, work: (c, stored) => writeRows(c, stored) };
    },
    pool,
  );

  if ("skip" in out) return out.skip;
  const p = out.stored.type === "journal.entry_written" ? out.stored.payload : null;
  return { ok: true, version: p!.version, event: out.stored };
}

/** Tablolar — event'in TEMİZLENMİŞ payload'ından. */
async function writeRows(client: pg.PoolClient, stored: RoomEvent): Promise<void> {
  if (stored.type !== "journal.entry_written") throw new Error(`beklenmeyen event: ${stored.type}`);
  const p = stored.payload;
  const room = stored.roomId;

  await client.query(
    `INSERT INTO journal_entries (room_id, agent_name, version, patch, snapshot, source, message_id)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)`,
    [room, p.agent, p.version, JSON.stringify(p.patch), JSON.stringify(p.snapshot), p.source, p.messageId],
  );

  for (const [ord, d] of p.decisions.entries()) {
    await client.query(
      `INSERT INTO decision_registry (room_id, owner, what, why, affects, version, ord)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (room_id, owner, what)
       DO UPDATE SET why = EXCLUDED.why, affects = EXCLUDED.affects, version = EXCLUDED.version, ord = EXCLUDED.ord`,
      [room, d.owner, d.what, d.why, d.affects, d.version, ord],
    );
  }

  // Kilit altında sahiplik `mergeJournalWrite`'ta sınandı. Buradaki WHERE'ler
  // son savunma hattı: tutmazsa transaction geri alınır, sessizce geçmez.
  if (p.removeContracts.length > 0) {
    const del = await client.query(
      `DELETE FROM contract_registry WHERE room_id = $1 AND owner = $2 AND name = ANY($3::text[])`,
      [room, p.agent, p.removeContracts],
    );
    if (del.rowCount !== p.removeContracts.length) {
      throw new Error(`sözleşme kaldırma tutmadı: ${del.rowCount}/${p.removeContracts.length}`);
    }
  }
  for (const c of p.contracts) {
    const up = await client.query(
      `INSERT INTO contract_registry (room_id, name, owner, shape, file, stability, source_sha256, version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (room_id, name)
       DO UPDATE SET shape = EXCLUDED.shape, file = EXCLUDED.file, stability = EXCLUDED.stability,
                     source_sha256 = EXCLUDED.source_sha256, version = EXCLUDED.version
       WHERE contract_registry.owner = EXCLUDED.owner`,
      [room, c.name, c.owner, c.shape, c.file, c.stability, c.sourceSha256, p.version],
    );
    if (up.rowCount !== 1) throw new Error(`sözleşme başka bir agent'ın: ${c.name}`);
  }
}

/** Odanın güncel defteri — agent başına son sürüm + siciller. */
export async function readJournalState(roomId: string, pool: pg.Pool = getPool()): Promise<JournalState> {
  return loadState(pool, roomId);
}

async function loadState(q: pg.Pool | pg.PoolClient, roomId: string): Promise<JournalState> {
  const snaps = await q.query<{ snapshot: unknown }>(
    `SELECT DISTINCT ON (agent_name) snapshot FROM journal_entries
      WHERE room_id = $1 ORDER BY agent_name, version DESC`,
    [roomId],
  );
  if (snaps.rowCount === 0) return EMPTY_JOURNAL;

  const decisions = await q.query(
    `SELECT owner, what, why, affects, version FROM decision_registry
      WHERE room_id = $1 ORDER BY owner COLLATE "C", version, ord`,
    [roomId],
  );
  const contracts = await q.query(
    `SELECT name, owner, shape, file, stability, source_sha256 AS "sourceSha256" FROM contract_registry
      WHERE room_id = $1 ORDER BY seq`,
    [roomId],
  );

  const snapshots: Record<string, JournalSnapshot> = {};
  for (const r of snaps.rows) {
    const s = JournalSnapshot.parse(r.snapshot);
    snapshots[s.agent] = s;
  }
  return {
    snapshots,
    decisions: decisions.rows.map((r) => DecisionRecord.parse(r)),
    contracts: contracts.rows.map((r) => Contract.parse(r)),
  };
}

export interface JournalHistoryRow {
  agent: string;
  version: number;
  source: JournalSource;
  messageId: string | null;
  patch: JournalPatch;
  snapshot: JournalSnapshot;
  createdAt: string;
}

/** Yazım geçmişi — hiçbir satır silinmez (Değişmez Kural 7). */
export async function readJournalHistory(
  roomId: string,
  opts: { agent?: string } = {},
  pool: pg.Pool = getPool(),
): Promise<JournalHistoryRow[]> {
  const res = await pool.query<{
    agent_name: string;
    version: number;
    source: JournalSource;
    message_id: string | null;
    patch: JournalPatch;
    snapshot: unknown;
    created_at: Date;
  }>(
    `SELECT agent_name, version, source, message_id, patch, snapshot, created_at FROM journal_entries
      WHERE room_id = $1 AND ($2::text IS NULL OR agent_name = $2)
      ORDER BY agent_name, version`,
    [roomId, opts.agent ?? null],
  );
  return res.rows.map((r) => ({
    agent: r.agent_name,
    version: r.version,
    source: r.source,
    messageId: r.message_id,
    patch: r.patch,
    snapshot: JournalSnapshot.parse(r.snapshot),
    createdAt: r.created_at.toISOString(),
  }));
}

/**
 * Bu turn'de değişen dosyalar, depo-göreli, sıralı, en fazla 50.
 *
 * `file.changed` oda-göreli gelir (`worktrees/backend/src/a.ts`): agent'ın
 * kendi workspace öneki atılır. `diff.updated` zaten depo-göreli.
 * `contract.changed` `contracts/` altına göreli: önek eklenir.
 */
async function turnTouched(
  client: pg.PoolClient,
  sessionId: string,
  messageId: string,
  workspace: string,
  config: RoomConfig,
): Promise<string[]> {
  const res = await client.query<{ type: string; payload: Record<string, unknown> }>(
    `SELECT type, payload FROM session_events
      WHERE session_id = $1 AND payload->>'messageId' = $2
        AND type IN ('file.changed', 'diff.updated', 'contract.changed')
      ORDER BY seq`,
    [sessionId, messageId],
  );
  const paths = new Set<string>();
  const ws = `${workspace}/`;
  for (const { type, payload } of res.rows) {
    if (type === "file.changed") {
      const p = String(payload.path);
      paths.add(p.startsWith(ws) ? p.slice(ws.length) : p);
    } else if (type === "diff.updated") {
      for (const f of payload.files as Array<{ path: string }>) paths.add(f.path);
    } else {
      paths.add(`${config.contractsDir}/${String(payload.path)}`);
    }
  }
  return [...paths].sort().slice(0, JOURNAL_LIMITS.touched);
}

/** `contracts/` altındaki her yolun log'daki son sha'sı; silinmişse yok. */
async function contractShas(client: pg.PoolClient, sessionId: string): Promise<Map<string, string>> {
  const res = await client.query<{ path: string; sha256: string; deleted: boolean }>(
    `SELECT DISTINCT ON (payload->>'path')
            payload->>'path' AS path, payload->>'sha256' AS sha256, (payload->>'deleted')::boolean AS deleted
       FROM session_events
      WHERE session_id = $1 AND type = 'contract.changed'
      ORDER BY payload->>'path', seq DESC`,
    [sessionId],
  );
  return new Map(res.rows.filter((r) => !r.deleted).map((r) => [r.path, r.sha256]));
}

/** "contracts/auth.md", "./contracts/auth.md", "/room/contracts/auth.md" → "auth.md"; dışındaysa null. */
function contractRelative(file: string, config: RoomConfig): string | null {
  const p = file.replace(/\\/g, "/").replace(/^\/room\//, "").replace(/^\.\//, "");
  const prefix = `${config.contractsDir}/`;
  if (!p.startsWith(prefix)) return null;
  const rel = p.slice(prefix.length);
  return rel.length > 0 && !rel.split("/").includes("..") ? rel : null;
}
