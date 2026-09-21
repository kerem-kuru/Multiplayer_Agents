import type pg from "pg";
import type { CheckpointKind, FileDiff, NewRoomEvent } from "@agent-rooms/protocol";
import { redactValue } from "@agent-rooms/redact";
import { execCapture } from "./agents/exec.js";
import { appendEventWith } from "./db/eventStore.js";
import { getPool } from "./db/pool.js";
import { getAllowPatterns } from "./redaction.js";

/**
 * Sunucunun gitkit'e bakan yüzü.
 *
 * **HOST BU DEPODA GİT ÇALIŞTIRMAZ.** Agent `.git/config` ve `.git/hooks/*`
 * dosyalarına yazabiliyor; host'ta koşan bir `git` onları host'ta
 * çalıştırabilirdi. Buradaki her şey `docker exec` ile container içinde.
 *
 * Bu kural bir GÜVENLİK kuralıdır, performans kuralı değil: "host'ta git
 * çalıştırmak daha kolay olurdu" gerekçesi geçerli değil (README karar
 * notları).
 */

/** Container içindeki gitkit CLI — `rooms/Dockerfile` bunu oraya kopyalıyor. */
export const GITKIT_PATH = "/opt/runner/gitkit/dist/gitkit.js";

export class GitkitError extends Error {
  constructor(
    readonly command: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`gitkit ${command} başarısız (kod ${exitCode}): ${stderr.trim().slice(0, 500)}`);
    this.name = "GitkitError";
  }
}

async function gitkit<T>(
  container: string,
  workdir: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<T> {
  const res = await execCapture({
    container,
    cmd: ["node", GITKIT_PATH, ...args, "--cwd", workdir],
    workdir,
    user: "agent",
    timeoutMs,
  });
  if (res.exitCode !== 0) throw new GitkitError(args[0] ?? "?", res.exitCode, res.stderr);
  const line = res.stdout.trim().split(/\r?\n/).pop() ?? "";
  try {
    return JSON.parse(line) as T;
  } catch {
    throw new GitkitError(args[0] ?? "?", res.exitCode, `JSON ayrıştırılamadı: ${line.slice(0, 200)}`);
  }
}

export interface CheckpointResult {
  checkpointId: string;
  commitSha: string;
  treeSha: string;
}

/**
 * Workspace'i depoya çevir ve TABAN checkpoint'ini al.
 *
 * Agent'ın İLK başlatılmasından önce bir kez çağrılır. Sonradan workspace'e
 * elle kopyalanan dosyalar agent değişikliği gibi görünür — bunu sıfırlamanın
 * yolu manuel checkpoint almaktır (README).
 */
export async function initWorkspace(
  container: string,
  workdir: string,
): Promise<CheckpointResult & { created: boolean }> {
  return gitkit(container, workdir, ["init-workspace"], 120_000);
}

export async function makeCheckpoint(
  container: string,
  workdir: string,
  label: string,
): Promise<CheckpointResult> {
  return gitkit(container, workdir, ["checkpoint", "--label", label]);
}

export async function currentTree(container: string, workdir: string): Promise<string> {
  const res = await gitkit<{ treeSha: string }>(container, workdir, ["tree"]);
  return res.treeSha;
}

/**
 * İsteğe bağlı diff: canlı tabandan BAŞKA bir checkpoint'e göre.
 *
 * Sonuç event log'a YAZILMAZ — bu kullanıcıya özel bir görünüm, herkesin
 * durumu değil. Ama yine de redaction'dan geçer: workspace içeriği sunan her
 * yol geçer.
 */
export async function diffFromCheckpoint(
  roomId: string,
  container: string,
  workdir: string,
  fromCheckpointId: string,
): Promise<{ baseTree: string; treeSha: string; files: FileDiff[] }> {
  const raw = await gitkit<{ baseTree: string; treeSha: string; files: FileDiff[] }>(
    container,
    workdir,
    ["diff", "--base-checkpoint", fromCheckpointId],
  );
  const allowPatterns = getAllowPatterns(roomId);
  return {
    ...raw,
    files: raw.files.map((f) => ({
      ...f,
      patch: f.patch === null ? null : redactValue(f.patch, { allowPatterns }).text,
    })),
  };
}

// --- checkpoints tablosu ---------------------------------------------------

export interface CheckpointRow {
  checkpointId: string;
  agentName: string;
  kind: CheckpointKind;
  label: string;
  commitSha: string;
  treeSha: string;
  messageId: string | null;
  createdBy: string | null;
  createdAt: string;
}

interface Row {
  id: string;
  agent_name: string;
  kind: CheckpointKind;
  label: string;
  commit_sha: string;
  tree_sha: string;
  message_id: string | null;
  created_by: string | null;
  created_at: Date;
}

const toRow = (r: Row): CheckpointRow => ({
  checkpointId: r.id,
  agentName: r.agent_name,
  kind: r.kind,
  label: r.label,
  commitSha: r.commit_sha,
  treeSha: r.tree_sha,
  messageId: r.message_id,
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
});

const CP_COLS = `id, agent_name, kind, label, commit_sha, tree_sha, message_id,
                 created_by, created_at`;

export async function listCheckpoints(
  roomId: string,
  agentName: string,
  pool: pg.Pool = getPool(),
): Promise<CheckpointRow[]> {
  const res = await pool.query<Row>(
    `SELECT ${CP_COLS} FROM checkpoints
      WHERE room_id = $1 AND agent_name = $2
      ORDER BY created_at DESC, id DESC`,
    [roomId, agentName],
  );
  return res.rows.map(toRow);
}

export async function getCheckpoint(
  roomId: string,
  checkpointId: string,
  pool: pg.Pool = getPool(),
): Promise<CheckpointRow | null> {
  const res = await pool.query<Row>(
    `SELECT ${CP_COLS} FROM checkpoints WHERE room_id = $1 AND id = $2`,
    [roomId, checkpointId],
  );
  const row = res.rows[0];
  return row ? toRow(row) : null;
}

/**
 * `checkpoint.created` event'i + `checkpoints` satırı — AYNI TRANSACTION'da.
 *
 * `checkpoints` tablosu Hafta 5'teki `agent_queue` gibi: işletim için otorite,
 * UI'a giden bilgi event'lerden gelir. İkisi ayrı düşerse tabanın iki cevabı
 * olur ve hangisinin doğru olduğu bilinemez.
 *
 * Runner'dan gelen `checkpoint.created` event'leri de buradan geçer
 * (AgentManager onları yakalıyor) — yazan kim olursa olsun tek yol.
 */
export async function recordCheckpoint(
  event: Extract<NewRoomEvent, { type: "checkpoint.created" }>,
  pool: pg.Pool = getPool(),
): Promise<void> {
  const p = event.payload;
  await appendEventWith(
    event,
    async (client) => {
      await client.query(
        `INSERT INTO checkpoints
           (id, room_id, agent_name, kind, label, commit_sha, tree_sha, message_id, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO NOTHING`,
        [
          p.checkpointId,
          event.roomId,
          p.agent,
          p.kind,
          p.label,
          p.commitSha,
          p.treeSha,
          p.messageId,
          p.by?.id ?? null,
        ],
      );
      /**
       * Taban KAYDI da aynı transaction'da: `becomesBase` olan bir
       * checkpoint yazılıp `agent_runtime` güncellenmeden çökülürse runner
       * bir sonraki açılışta ESKİ tabanı alır ve diff sessizce yanlış olur.
       */
      if (p.becomesBase) {
        await client.query(
          `UPDATE agent_runtime SET diff_base_checkpoint_id = $3, updated_at = now()
            WHERE room_id = $1 AND agent_name = $2`,
          [event.roomId, p.agent, p.checkpointId],
        );
      }
    },
    pool,
  );
}
