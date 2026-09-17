import path from "node:path";
import type pg from "pg";
import type { Actor, RoomConfig, RoomEvent } from "@agent-rooms/protocol";
import { getPool } from "../db/pool.js";
import { appendEvent } from "../db/eventStore.js";
import {
  imageExists,
  roomContainerName,
  startRoomContainer,
  stopRoomContainer,
} from "../docker/container.js";
import { provisionAgentUsers, type ProvisionStep } from "../docker/isolation.js";
import { scaffoldRoomLayout } from "./layout.js";
import {
  attachContainer,
  createRoom,
  createSession,
  endSession,
  latestSession,
  type RoomRecord,
  type SessionRecord,
} from "./rooms.js";

/**
 * `POST /rooms`'un tamamı. API katmanı ince kalsın diye orkestrasyon burada:
 * HTTP olmadan da test edilebilir ve Hafta 12'de CLI aynı fonksiyonu çağırır.
 *
 * Sıra önemli:
 *   1. oda + oturum kaydı  — event yazabilmek için önce oturum gerekir
 *   2. klasör düzeni       — container mount'u buna bağlanacak
 *   3. room.created        — container açılmasa bile bu event yazılmış olmalı
 *   4. container + provision
 *   5. session.started     — containerId'yi taşır, o yüzden en sonda
 *
 * 4. adım patlarsa 5 hiç yazılmaz; yerine `session.ended{reason:"crashed"}`
 * düşer. Log'da "başladı" görünüp aslında başlamamış bir oturum kalmaz.
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
  roomRoot: string;
  dirs: string[];
  containerId: string | null;
  containerName: string | null;
  provision: ProvisionStep[];
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
  const session = await createSession(room.id, pool);
  const roomRoot = path.join(roomsDataDir, room.id);
  const dirs = await scaffoldRoomLayout(roomRoot, config);
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
      roomRoot,
      dirs,
      containerId: null,
      containerName: null,
      provision: [],
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
    containerId = await startRoomContainer({ roomId: room.id, roomRoot, image });
    const provision = await provisionAgentUsers(containerId, config);
    await attachContainer(session.id, containerId, pool);

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
      roomRoot,
      dirs,
      containerId,
      containerName: roomContainerName(room.id),
      provision,
      events,
    };
  } catch (err) {
    if (containerId) await stopRoomContainer(containerId);
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
