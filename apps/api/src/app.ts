import path from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import type { Actor } from "@agent-rooms/protocol";
import { PROTOCOL_VERSION } from "@agent-rooms/protocol";
import {
  closeRoom,
  containerStatus,
  getRoom,
  getRoomConfig,
  isolationHolds,
  latestSession,
  listRooms,
  loadRoomConfig,
  openRoom,
  readEvents,
  readJournal,
  verifyIsolation,
} from "@agent-rooms/core";
import { loadApiConfig, resolveConfigPath, type ApiConfig } from "./config.js";

/**
 * Tek API yüzeyi — insanlar ve (Hafta 8'den itibaren) agent'lar aynı
 * endpoint'leri kullanır. Bu hafta sadece oda yaşam döngüsü ve okuma var;
 * mesaj/görev/onay uçları ilerleyen haftalarda aynı dosyaya eklenecek.
 *
 * SSE Hafta 3'te: `GET /rooms/:id/events` bugün düz JSON döner, aynı `since`
 * sözleşmesiyle. İstemci tarafı değişmeden stream'e geçebilsin diye.
 */

const Uuid = z.string().uuid();

const CreateRoomBody = z
  .object({
    /** Repo köküne göre rol YAML'ı. Verilmezse config/room.example.yaml. */
    configPath: z.string().min(1).optional(),
    /** Container'ı atla — docker'sız ortamda DB + klasör tarafını denemek için. */
    spawnContainer: z.boolean().optional(),
  })
  .strict();

const EventsQuery = z.object({
  since: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().positive().max(1000).default(500),
});

class HttpError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 500,
    message: string,
    readonly issues?: string[],
  ) {
    super(message);
  }
}

/**
 * İsteği kimin yaptığı. Auth Hafta 4'te (magic link) gelecek; o zamana kadar
 * başlıktan okunuyor. Şekli şimdiden doğru olsun ki Hafta 5'teki `[Ali]: ...`
 * etiketi ve sürücü devri aynı `Actor` tipine otursun.
 */
function actorFrom(header: string | undefined, name: string | undefined): Actor {
  if (header) return { kind: "human", id: header, name: name || header };
  return { kind: "system" };
}

export function createApp(cfg: ApiConfig = loadApiConfig()) {
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      week: 1,
      roomImage: cfg.roomImage,
      spawnContainer: cfg.spawnContainer,
    }),
  );

  app.get("/rooms", async (c) => c.json({ rooms: await listRooms() }));

  app.post("/rooms", async (c) => {
    const raw = await c.req.json().catch(() => ({}));
    const parsed = CreateRoomBody.safeParse(raw);
    if (!parsed.success) {
      throw new HttpError(
        400,
        "istek gövdesi geçersiz",
        parsed.error.issues.map((i) => `${i.path.join(".") || "<kök>"}: ${i.message}`),
      );
    }

    const configPath = resolveConfigPath(cfg, parsed.data.configPath);
    const { config, digest } = await loadRoomConfig(configPath);

    const result = await openRoom({
      config,
      configDigest: digest,
      roomsDataDir: cfg.roomsDataDir,
      image: cfg.roomImage,
      actor: actorFrom(c.req.header("x-user-id"), c.req.header("x-user-name")),
      spawnContainer: parsed.data.spawnContainer ?? cfg.spawnContainer,
    });

    return c.json(
      {
        room: result.room,
        session: { ...result.session, containerId: result.containerId },
        container: result.containerId
          ? { id: result.containerId, name: result.containerName }
          : null,
        layout: {
          root: result.roomRoot,
          dirs: result.dirs.map((d) => path.relative(result.roomRoot, d).replace(/\\/g, "/")),
        },
        agents: config.agents.map((a) => ({ name: a.name, workspace: a.workspace })),
        events: result.events.map((e) => ({ seq: e.seq, type: e.type })),
      },
      201,
    );
  });

  app.get("/rooms/:id", async (c) => {
    const { room } = await mustFindRoom(c.req.param("id"));
    const session = await latestSession(room.id);
    const status = session?.containerId ? await containerStatus(session.containerId) : null;
    return c.json({ room, session, container: session?.containerId ? { status } : null });
  });

  app.get("/rooms/:id/events", async (c) => {
    const { room } = await mustFindRoom(c.req.param("id"));
    const session = await latestSession(room.id);
    if (!session) throw new HttpError(404, "bu odanın oturumu yok");

    const q = EventsQuery.safeParse({
      since: c.req.query("since") ?? 0,
      limit: c.req.query("limit") ?? 500,
    });
    if (!q.success) throw new HttpError(400, "since/limit geçersiz");

    const events = await readEvents(session.id, q.data);
    return c.json({
      sessionId: session.id,
      since: q.data.since,
      /** İstemci bir sonraki isteğinde bunu `since` olarak yollar. */
      nextSince: events.length > 0 ? events[events.length - 1]!.seq : q.data.since,
      events,
    });
  });

  app.get("/rooms/:id/journal", async (c) => {
    const { room, config } = await mustFindRoom(c.req.param("id"));
    const roomRoot = path.join(cfg.roomsDataDir, room.id);
    return c.json(await readJournal(roomRoot, config));
  });

  /**
   * Cuma dogfood kapısı, endpoint hâli: izolasyon container içinde gerçekten
   * tutuyor mu? Her agent kullanıcısı adına yazma denemesi yapar.
   */
  app.get("/rooms/:id/isolation", async (c) => {
    const { room, config } = await mustFindRoom(c.req.param("id"));
    const session = await latestSession(room.id);
    if (!session?.containerId) throw new HttpError(409, "odanın ayakta container'ı yok");

    const checks = await verifyIsolation(session.containerId, config);
    return c.json({ holds: isolationHolds(checks), checks });
  });

  app.post("/rooms/:id/stop", async (c) => {
    const { room } = await mustFindRoom(c.req.param("id"));
    const event = await closeRoom({
      roomId: room.id,
      actor: actorFrom(c.req.header("x-user-id"), c.req.header("x-user-name")),
    });
    return c.json({ stopped: true, event: event ? { seq: event.seq, type: event.type } : null });
  });

  app.notFound((c) => c.json({ error: "böyle bir uç yok" }, 404));

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message, issues: err.issues ?? [] }, err.status);
    }
    // Beklenmeyen hata: mesajı geç, yığını geçme.
    console.error(err);
    return c.json({ error: String(err instanceof Error ? err.message : err) }, 500);
  });

  return app;
}

/** Oda + açıldığı andaki konfigürasyonu. YAML sonradan değişse de bu kopya durur. */
async function mustFindRoom(id: string) {
  if (!Uuid.safeParse(id).success) throw new HttpError(400, "oda kimliği UUID değil");
  const room = await getRoom(id);
  if (!room) throw new HttpError(404, "oda bulunamadı");
  const config = await getRoomConfig(id);
  if (!config) throw new HttpError(500, "odanın konfigürasyonu okunamadı");
  return { room, config };
}
