import type pg from "pg";
import type { RoomConfig } from "@agent-rooms/protocol";
import { RoomConfig as RoomConfigSchema } from "@agent-rooms/protocol";
import { appendEvent } from "./db/eventStore.js";
import { getPool } from "./db/pool.js";
import { listRoomContainers } from "./docker/container.js";
import { readUids } from "./agents/runtime.js";
import { assignUids, applyFsPlan, planRoomFs, verifyFsPlan, type FsDrift } from "./room-fs.js";
import { latestSession } from "./room/rooms.js";

/**
 * Hafta 7, Adım 9 — izin denetimi.
 *
 * Agent kendi worktree dizininin SAHİBİ olduğu için iznini değiştirebilir
 * (`chmod 777 .`). Bu yalnızca kendi izolasyonunu zayıflatır — başkasının
 * klasörüne yazamaz — ama sessiz kalmamalı: odaya bakan ikinci kişi "bu klasör
 * artık herkese açık" bilgisini görmeli.
 *
 * **Düzelten taraf ile kayan taraf ayrı.** Runner düzeltemez (agent
 * kullanıcısıyla koşuyor, `chown` root ister); yalnızca bildirir. Düzeltmeyi
 * AgentManager/sunucu root exec ile yapar ve TEK bir `isolation.violation`
 * event'i yazar: `fixed` alanı düzeltmenin tutup tutmadığını söyler.
 *
 * İki tetikleyici var:
 *   1. turn sonunda runner'ın `isolation_drift` bildirimi (anında)
 *   2. sunucuda 5 dakikada bir tüm odalar (agent boştayken yapılanları yakalar)
 */

/** İki tetikleyicinin de kullandığı denetim aralığı. */
export const ISOLATION_AUDIT_INTERVAL_MS = 300_000;

export interface AuditResult {
  roomId: string;
  drifts: FsDrift[];
  fixed: boolean;
}

/** Sapmanın hangi agent'a ait olduğunu yoldan çıkarır. */
function agentOfPath(path: string): string | null {
  const m = /^\/room\/worktrees\/([^/]+)$/.exec(path);
  return m?.[1] ?? null;
}

/**
 * Bir odayı denetler; kayma varsa düzeltir ve event yazar.
 *
 * Düzeltme, planın TAMAMINI yeniden uygulamak: plan idempotent olduğu için
 * bu güvenli ve "beklenen izin" tanımının tek kopyasını kullanıyor.
 */
export async function auditRoomIsolation(opts: {
  roomId: string;
  container: string;
  config: RoomConfig;
  pool?: pg.Pool;
}): Promise<AuditResult> {
  const { roomId, container, config, pool = getPool() } = opts;

  const uids = assignUids(
    config.agents.map((a) => a.name),
    await readUids(roomId, pool),
  );
  const plan = planRoomFs(config, uids);

  const drifts = await verifyFsPlan(container, plan);
  if (drifts.length === 0) return { roomId, drifts: [], fixed: true };

  let fixed = true;
  try {
    await applyFsPlan(container, plan);
    // Düzeltme tuttu mu: ÖLÇ, varsaymadan.
    const after = await verifyFsPlan(container, plan);
    fixed = after.length === 0;
  } catch {
    fixed = false;
  }

  const session = await latestSession(roomId, pool);
  if (!session) return { roomId, drifts, fixed };

  for (const d of drifts) {
    const agent = agentOfPath(d.path);
    // Agent'a bağlanamayan sapmalar (ör. /room/contracts) da yazılıyor ama
    // `agent` alanı zorunlu olduğu için sahibi bilinen ilk agent'a değil,
    // atlanıyor: yanlış agent'ı suçlamak log'u yalancı yapar.
    if (!agent) continue;
    await appendEvent(
      {
        roomId,
        sessionId: session.id,
        actor: { kind: "system" },
        type: "isolation.violation",
        payload: { agent, path: d.path, expected: d.expected, actual: d.actual, fixed },
      },
      pool,
    ).catch(() => undefined);
  }

  return { roomId, drifts, fixed };
}

/** Odanın config'ini DB'den okur — YAML sonradan değişse bile oda kendi kopyasıyla çalışır. */
async function roomConfigOf(roomId: string, pool: pg.Pool): Promise<RoomConfig | null> {
  const res = await pool.query<{ config: unknown }>(`SELECT config FROM rooms WHERE id = $1`, [
    roomId,
  ]);
  const raw = res.rows[0]?.config;
  if (!raw) return null;
  const parsed = RoomConfigSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Çalışan tüm odaları denetler. */
export async function auditAllRooms(pool: pg.Pool = getPool()): Promise<AuditResult[]> {
  const rooms = await pool.query<{ id: string }>(
    `SELECT id FROM rooms WHERE status = 'running'`,
  );
  const out: AuditResult[] = [];
  for (const { id } of rooms.rows) {
    const containers = await listRoomContainers(id);
    const running = containers.find((c) => c.State === "running");
    if (!running) continue;
    const config = await roomConfigOf(id, pool);
    if (!config) continue;
    const res = await auditRoomIsolation({
      roomId: id,
      container: running.Id,
      config,
      pool,
    }).catch(() => null);
    if (res && res.drifts.length > 0) out.push(res);
  }
  return out;
}

/** 5 dakikada bir. Agent boştayken yapılan değişiklikleri yakalar. */
export function startIsolationAudit(
  intervalMs = ISOLATION_AUDIT_INTERVAL_MS,
  pool: pg.Pool = getPool(),
  notify: (message: string) => void = () => undefined,
): () => void {
  const timer = setInterval(() => {
    auditAllRooms(pool)
      .then((results) => {
        for (const r of results) {
          notify(
            `izin kayması: oda ${r.roomId} — ${r.drifts.length} klasör, ` +
              `düzeltme ${r.fixed ? "tuttu" : "TUTMADI"}`,
          );
        }
      })
      .catch((err) => notify(`izin denetimi düştü: ${String(err)}`));
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
