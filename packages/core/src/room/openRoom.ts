import type pg from "pg";
import type { Actor, RoomConfig, RoomEvent } from "@agent-rooms/protocol";
import { getPool } from "../db/pool.js";
import { appendEvent } from "../db/eventStore.js";
import {
  imageExists,
  removeRoomVolume,
  roomContainerName,
  roomVolumeName,
  startRoomContainer,
  stopRoomContainer,
} from "../docker/container.js";
import { applyFsPlan, assignUids, planRoomFs } from "../room-fs.js";
import { cloneForAgents, initCentralRepo } from "../repo.js";
import { ensureRuntimeRows, readUids, writeUids } from "../agents/runtime.js";
import { ensureDriverRows } from "../driver.js";
import { setRoomAllowPatterns } from "../redaction.js";
import {
  attachContainer,
  createRoom,
  createSession,
  endSession,
  latestSession,
  setBaseSha,
  type RoomRecord,
  type SessionRecord,
} from "./rooms.js";

/**
 * `POST /rooms`'un tamamı. API katmanı ince kalsın diye orkestrasyon burada:
 * HTTP olmadan da test edilebilir ve Hafta 12'de CLI aynı fonksiyonu çağırır.
 *
 * Sıra önemli:
 *   1. oda + oturum kaydı  — event yazabilmek için önce oturum gerekir
 *   2. uid ataması         — DB'ye yazılır, bir daha değişmez
 *   3. room.created        — container açılmasa bile bu event yazılmış olmalı
 *   4. container (volume)  — /room artık named volume, host klasörü değil
 *   5. izin planı          — root exec: kullanıcılar, gruplar, 0750 klasörler
 *   6. session.started     — containerId'yi taşır, o yüzden en sonda
 *
 * 4-5 patlarsa 6 hiç yazılmaz; yerine `session.ended{reason:"crashed"}`
 * düşer. Log'da "başladı" görünüp aslında başlamamış bir oturum kalmaz.
 *
 * Hafta 7: host tarafında klasör AÇILMIYOR. `scaffoldRoomLayout` kaldırıldı —
 * `/room` bir named volume ve host onu göremiyor (Karar 2). Klasörleri izin
 * planı container İÇİNDE yaratıyor, doğru sahip ve modla.
 */

export interface OpenRoomInput {
  config: RoomConfig;
  configDigest: string;
  /** Oda klasörlerinin kökü — oda başına alt dizin açılır. */
  roomsDataDir: string;
  image: string;
  actor: Actor;
  /** false: container açılmaz. Docker'sız ortamda DB + klasör tarafını denemek için. */
  spawnContainer?: boolean;
  pool?: pg.Pool;
}

export interface OpenRoomResult {
  room: RoomRecord;
  session: SessionRecord;
  /** Oda volume'unun adı — host'ta klasör yok (Hafta 7, Karar 2). */
  volume: string;
  /** Container içindeki klasörler, plandan. */
  dirs: string[];
  /** Agent adı → Unix uid. DB'ye yazıldı, bir daha değişmeyecek. */
  uids: Record<string, number>;
  containerId: string | null;
  containerName: string | null;
  events: RoomEvent[];
}

export async function openRoom(input: OpenRoomInput): Promise<OpenRoomResult> {
  const {
    config,
    configDigest,
    roomsDataDir,
    image,
    actor,
    spawnContainer = true,
    pool = getPool(),
  } = input;

  const room = await createRoom(config, configDigest, pool);

  // Redaction ayarını İLK event'ten önce kaydet: `room.created` de geçitten
  // geçiyor ve odanın kendi `allow_patterns`'ı o anda bilinmeli.
  setRoomAllowPatterns(room.id, config.redaction?.allow_patterns ?? []);
  const session = await createSession(room.id, pool);
  // YAML'daki her agent için bir çalışma durumu satırı — hepsi 'stopped'.
  await ensureRuntimeRows(room.id, config.agents.map((a) => a.name), pool);

  /**
   * uid ataması container'dan ÖNCE ve DB'ye yazılarak yapılır.
   *
   * Sonra yapılsaydı: container açılır, plan uygulanır, sonra DB yazımı
   * patlarsa dosyalar bir uid'e ait olur ama kimse hangisi olduğunu
   * bilmez. Önce yazmak, en kötü ihtimalle kullanılmayan bir uid bırakır.
   */
  const uids = assignUids(
    config.agents.map((a) => a.name),
    await readUids(room.id, pool),
  );
  await writeUids(room.id, uids, {}, pool);
  const plan = planRoomFs(config, uids);
  const dirs = plan.dirs.map((d) => d.path);
  /**
   * Ve bir sürücü satırı — `user_id = NULL`, yani "sürücü yok".
   *
   * Satır önceden var olmalı: sürücülüğü almak bir UPDATE, INSERT değil.
   * Böylece iki kişi aynı anda sürücülük isterse satır kilidi ikinciyi
   * bekletir ve o `409` görür.
   */
  await ensureDriverRows(room.id, config.agents.map((a) => a.name), pool);
  const events: RoomEvent[] = [];

  const base = { roomId: room.id, sessionId: session.id, actor } as const;

  events.push(
    await appendEvent(
      {
        ...base,
        type: "room.created",
        payload: { name: config.name, repoUrl: config.repoUrl, configDigest },
      },
      pool,
    ),
  );

  if (!spawnContainer) {
    return {
      room,
      session,
      volume: roomVolumeName(room.id),
      dirs,
      uids,
      containerId: null,
      containerName: null,
      events,
    };
  }

  if (!(await imageExists(image))) {
    throw new Error(
      `oda imajı bulunamadı: ${image} — "docker compose --profile build-only build room" koş`,
    );
  }

  let containerId: string | null = null;
  try {
    containerId = await startRoomContainer({
      roomId: room.id,
      image,
      agentCount: config.agents.length,
    });
    await attachContainer(session.id, containerId, pool);

    // İzolasyonun kurulduğu yer. Buradan sonra her agent kendi Unix
    // kullanıcısıdır ve kendi klasörü dışına yazamaz.
    await applyFsPlan(containerId, plan);

    /*
     * Merkez depo ve agent klonları — izin planından SONRA.
     *
     * Sıra zorunlu: klonlar agent kullanıcılarıyla, kendi worktree
     * klasörlerinin içine yapılıyor. O kullanıcılar ve klasörler plan
     * uygulanmadan yok.
     */
    const repoInfo = await initCentralRepo({
      container: containerId,
      roomId: room.id,
      config,
      image,
    });
    await setBaseSha(room.id, config.repo, repoInfo.baseSha, pool);

    events.push(
      await appendEvent(
        { ...base, type: "room.repo_initialized", payload: repoInfo },
        pool,
      ),
    );

    const clones = await cloneForAgents({
      container: containerId,
      roomId: room.id,
      config,
      baseSha: repoInfo.baseSha,
    });
    await writeUids(
      room.id,
      uids,
      Object.fromEntries(clones.map((c) => [c.agent, c.branch])),
      pool,
    );

    for (const c of clones) {
      events.push(
        await appendEvent(
          {
            ...base,
            type: "agent.workspace_ready",
            payload: { agent: c.agent, branch: c.branch, baseSha: repoInfo.baseSha },
          },
          pool,
        ),
      );
    }

    events.push(
      await appendEvent(
        {
          ...base,
          type: "session.started",
          payload: { containerId, agents: config.agents.map((a) => a.name) },
        },
        pool,
      ),
    );

    return {
      room,
      session,
      volume: roomVolumeName(room.id),
      dirs,
      uids,
      containerId,
      containerName: roomContainerName(room.id),
      events,
    };
  } catch (err) {
    if (containerId) await stopRoomContainer(containerId);
    // Yarım kalmış oda volume'u bırakma: sweeper'a iş çıkarmadan burada sil.
    await removeRoomVolume(room.id).catch(() => undefined);
    await appendEvent(
      {
        ...base,
        type: "session.ended",
        payload: { reason: "crashed", detail: String(err).slice(0, 2000) },
      },
      pool,
    ).catch(() => undefined);
    await endSession(session.id, pool).catch(() => undefined);
    throw err;
  }
}

export interface CloseRoomInput {
  roomId: string;
  actor: Actor;
  reason?: "user_stopped" | "crashed" | "budget_exhausted" | "idle_timeout";
  detail?: string | null;
  pool?: pg.Pool;
}

/** Oturumu kapatır ve container'ı siler. Oda kaydı DURUR — append-only, silinmez. */
export async function closeRoom(input: CloseRoomInput): Promise<RoomEvent | null> {
  const { roomId, actor, reason = "user_stopped", detail = null, pool = getPool() } = input;

  const session = await latestSession(roomId, pool);
  if (!session) return null;

  let event: RoomEvent | null = null;
  if (session.status !== "ended") {
    event = await appendEvent(
      { roomId, sessionId: session.id, actor, type: "session.ended", payload: { reason, detail } },
      pool,
    );
  }

  await stopRoomContainer(session.containerId ?? roomContainerName(roomId));
  await endSession(session.id, pool);
  return event;
}
