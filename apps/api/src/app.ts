import path from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import type { Actor } from "@agent-rooms/protocol";
import { NewRoomEvent, PROTOCOL_VERSION } from "@agent-rooms/protocol";
import { SNAPSHOT_VERSION } from "@agent-rooms/view";
import { redactValue } from "@agent-rooms/redact";
import {
  AgentManager,
  AgentQueue,
  FakeAgentRuntime,
  AgentCredentialsError,
  AgentNotFoundError,
  AgentStartError,
  appendEvent,
  closeRoom,
  containerStatus,
  getPool,
  getRoom,
  getRoomConfig,
  getEventBus,
  getSession,
  currentView,
  latestSnapshot,
  latestSession,
  listRooms,
  loadRoomConfig,
  RoomConfigError,
  openRoom,
  listRoomsOverview,
  listPresence,
  listRuntime,
  presenceConnectionCount,
  readEvents,
  setViewing,
  readJournal,
  archiveRoom,
  execCapture,
  readContract,
  getAllowPatterns,
  markSeen,
  readMarks,} from "@agent-rooms/core";
import { loadApiConfig, resolveConfigPath, type ApiConfig } from "./config.js";
import { HttpError } from "./http-error.js";
import {
  addMember,
  listMembers,
  requireRoom,
  requireUser,
  setMemberRole,
  type Role,
} from "./auth/guard.js";
import { authRoutes } from "./routes/auth.js";
import { accessRoutes } from "./routes/access.js";
import { inviteRoutes } from "./routes/invites.js";
import { messageRoutes } from "./routes/messages.js";
import { driverRoutes } from "./routes/driver.js";
import { interruptRoutes } from "./routes/interrupt.js";
import { reviewRoutes } from "./routes/reviews.js";
import { checkpointRoutes } from "./routes/checkpoints.js";
import { resolveSince, streamSession, wantsSse } from "./routes/events-sse.js";

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

const MemberRoleBody = z.object({ role: z.enum(["owner", "member", "viewer"]) }).strict();
const SeenBody = z.object({ seq: z.number().int().nonnegative() }).strict();

const PresenceBody = z
  .object({
    viewing: z.string().min(1).max(120).nullable(),
    /**
     * Hangi SEKME bakış değiştirdi. İstemci bunu ilk SSE frame'inden
     * (`hello`) alır. Verilmezse kullanıcının tüm bağlantıları güncellenir —
     * eski istemciler bozulmasın diye, ama doğru olan bunu göndermek.
     */
    connectionId: z.string().min(1).max(200).optional(),
  })
  .strict();

/**
 * İsteği kimin yaptığı — Hafta 4'ten itibaren OTURUMDAN gelir, başlıktan
 * değil. İstemcinin söylediği kimliğe güvenmek, `[Ali]: ...` etiketini
 * (Hafta 5) anlamsız kılardı.
 */
function actorOf(user: { id: string; name: string }): Actor {
  return { kind: "human", id: user.id, name: user.name };
}

export function createApp(
  cfg: ApiConfig = loadApiConfig(),
  manager?: AgentManager,
  queue?: AgentQueue,
) {
  const app = new Hono();

  /**
   * Kuyruk yoksa yazma uçları hiç tanımlanmaz: 404 yerine 503 dönmek için
   * aşağıda açıkça söylenir. Sessizce kabul edip hiçbir şey yapmamak en kötü
   * seçenek olurdu.
   */
  if (queue) {
    app.route("/", messageRoutes(queue));
    app.route("/", interruptRoutes(queue));
    // İnceleme uçları kuyruğa bağlı: bir incelemenin yorumları TEK turn.
    app.route("/", reviewRoutes(queue));
  }
  app.route("/", driverRoutes());
  /** Yetki isteği: izleyicinin "beni katılımcı yap" yolu. Kuyruğa bağlı değil. */
  app.route("/", accessRoutes());
  /**
   * Checkpoint ve isteğe bağlı diff. Manager verilmezse manuel checkpoint
   * yine alınır ama koşan runner'a `set_base` gönderilemez — yeni tabanı bir
   * sonraki başlangıçta öğrenir.
   */
  app.route("/", checkpointRoutes(manager));

  /** Anahtar yoksa agent uçları kapalı — sessizce boş cevap vermek yerine söyle. */
  const requireManager = (): AgentManager => {
    if (!manager) {
      throw new HttpError(503, "agent koşumu kapalı — ANTHROPIC_API_KEY tanımlı değil");
    }
    return manager;
  };

  // DB'ye gerçekten dokunur: "ayakta" demek "yazabiliyorum" demektir.
  app.get("/health", async (c) => {
    try {
      await getPool().query("SELECT 1");
    } catch (err) {
      return c.json(
        { ok: false, db: false, error: err instanceof Error ? err.message : String(err) },
        503,
      );
    }
    const mem = process.memoryUsage();
    return c.json({
      ok: true,
      db: true,
      protocolVersion: PROTOCOL_VERSION,
      week: 7,
      roomImage: cfg.roomImage,
      spawnContainer: cfg.spawnContainer,
      /**
       * Sızıntı denetimi: bağlan-kopar döngüsünden sonra `sseSubscribers`
       * 0'a dönmeli ve `heapUsedMb` şişmemeli. Kapı testi bu iki değeri okur.
       */
      sseSubscribers: getEventBus().subscriberCount(),
      presenceConnections: presenceConnectionCount(),
      heapUsedMb: Number((mem.heapUsed / 1024 / 1024).toFixed(1)),
    });
  });

  // Auth ve davet uçları — bunlar oda üyeliği İSTEMEZ (giriş yolu onlar).
  app.route("/", authRoutes(cfg));
  app.route("/", inviteRoutes(cfg));

  /** Sadece ÜYE olduğun odalar. Gizleme UI'da değil sorguda. */
  app.get("/rooms", async (c) => {
    const user = await requireUser(c);
    return c.json({ rooms: await listRoomsOverview(50, getPool(), user.id) });
  });

  app.post("/rooms", async (c) => {
    const user = await requireUser(c);
    const raw = await c.req.json().catch(() => ({}));
    const parsed = CreateRoomBody.safeParse(raw);
    if (!parsed.success) {
      throw new HttpError(
        400,
        "istek gövdesi geçersiz",
        parsed.error.issues.map((i) => `${i.path.join(".") || "<kök>"}: ${i.message}`),
      );
    }

    // Geçersiz config İSTEMCİ hatasıdır (400), sunucu hatası değil: Hafta 7
    // kuralları ("her worktree'nin tek yazarı sahibidir") burada reddediliyor
    // ve mesaj kullanıcıya olduğu gibi ulaşmalı.
    let loaded: Awaited<ReturnType<typeof loadRoomConfig>>;
    try {
      loaded = await loadRoomConfig(resolveConfigPath(cfg, parsed.data.configPath));
    } catch (err) {
      // Mesajın başı sunucudaki dosya yolu ("C:\...\room.yaml: ..."); istemciye gitmez.
      if (err instanceof RoomConfigError) {
        throw new HttpError(400, err.message.slice(err.message.lastIndexOf(": ") + 2), err.issues);
      }
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") throw new HttpError(400, "konfigürasyon dosyası bulunamadı");
      throw new HttpError(400, err instanceof Error ? err.message : String(err));
    }
    const { config, digest } = loaded;

    const result = await openRoom({
      config,
      configDigest: digest,
      roomsDataDir: cfg.roomsDataDir,
      image: cfg.roomImage,
      actor: actorOf(user),
      spawnContainer: parsed.data.spawnContainer ?? cfg.spawnContainer,
    });

    // Odayı açan onun sahibidir: davet edebilir, agent başlatabilir.
    await addMember(result.room.id, user.id, "owner");
    await getPool().query(`UPDATE rooms SET created_by = $1 WHERE id = $2`, [
      user.id,
      result.room.id,
    ]);

    return c.json(
      {
        room: result.room,
        session: { ...result.session, containerId: result.containerId },
        container: result.containerId
          ? { id: result.containerId, name: result.containerName }
          : null,
        // Hafta 7: /room bir named volume; host'ta karsiligi olan bir klasor
        // yok. Buradaki yollar container ICINDEKI yollardir.
        layout: {
          volume: result.volume,
          dirs: result.dirs,
          uids: result.uids,
        },
        agents: config.agents.map((a) => ({ name: a.name, workspace: a.workspace })),
        events: result.events.map((e) => ({ seq: e.seq, type: e.type })),
      },
      201,
    );
  });

  /**
   * Odayı arşivle (Hafta 7, Adım 10).
   *
   * Container ve volume gider; `rooms` satırı ve event log DURUR — append-only
   * kuralı. Odanın tarihi okunmaya devam eder.
   *
   * Yalnızca `owner`: bu geri alınamaz ve odadaki herkesin işini bitirir.
   */
  app.delete("/rooms/:id", async (c) => {
    await requireRoom(c, c.req.param("id"), "owner");
    const { room } = await mustFindRoom(c.req.param("id"));

    // Önce runner'lara kapanma sinyali: süreçler container'la birlikte
    // öldürülürse yarım kalan turn'ün sebebi log'a yazılmaz.
    // Agent yöneticisi yoksa (anahtarsız kurulum) zaten koşan runner yok.
    await manager?.shutdownRoom(room.id).catch(() => undefined);
    await archiveRoom(room.id, getPool(), (level, message) => {
      if (level === "warn") console.warn(message);
      else console.log(message);
    });
    return c.json({ ok: true, roomId: room.id, status: "archived" });
  });

  /**
   * Bir sözleşme dosyasının İÇERİĞİ (Hafta 7, Adım 7).
   *
   * İçerik event log'a girmiyor (orada yalnızca sha256 ve boyut var); görmek
   * isteyen buradan okuyor. Redaction'dan GEÇER: workspace içeriği sunan her
   * yol geçer.
   *
   * Dosya root ile DEĞİL, ayrıcalıksız `nobody:rooms-contracts` ile okunuyor:
   * contracts/ içindeki symlink agent'ın elinden çıkmış veridir. Root ile
   * okuyan ilk sürüm başka agent'ın dosyasını ve /etc/shadow'u sızdırdı.
   * Ayrıntı: packages/core/src/contracts-read.ts.
   */
  app.get("/rooms/:id/contracts/*", async (c) => {
    await requireRoom(c, c.req.param("id"));
    const { room } = await mustFindRoom(c.req.param("id"));
    const session = await latestSession(room.id);
    if (!session?.containerId) throw new HttpError(409, "oda çalışmıyor");

    const rel = c.req.path.split("/contracts/")[1] ?? "";
    // Symlink ve `..` kaçışı readContract içinde: ayrıcalıksız kimlik + realpath.
    const res = await readContract(session.containerId, rel);
    if (!res.ok && res.reason === "outside") throw new HttpError(400, "geçersiz sözleşme yolu");
    if (!res.ok) throw new HttpError(404, "sözleşme dosyası bulunamadı");

    return c.json({
      path: rel,
      content: redactValue(res.content, { allowPatterns: getAllowPatterns(room.id) }).text,
    });
  });

  /**
   * Okunmamış işaretleri (Hafta 7, Adım 12).
   *
   * Kullanıcıya özel durum: event log'a yazılmıyor.
   */
  app.get("/rooms/:id/reads", async (c) => {
    const { user } = await requireRoom(c, c.req.param("id"));
    return c.json({ reads: await readMarks(user.id, c.req.param("id")) });
  });

  /**
   * "Buraya kadar gördüm." Detay sayfası açıkken ve sekme görünürken çağrılır
   * (istemcide 5 sn debounce). Değer GERİYE GİTMEZ — `markSeen` GREATEST ile
   * uyguluyor, yani iki sekmenin çağrı sırası önemsiz.
   */
  app.post("/rooms/:id/agents/:aid/seen", async (c) => {
    const { user } = await requireRoom(c, c.req.param("id"));
    const body = SeenBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw new HttpError(400, "seq alanı gerekli (tam sayı)");
    const seq = await markSeen(user.id, c.req.param("id"), c.req.param("aid"), body.data.seq);
    return c.json({ agent: c.req.param("aid"), lastSeenSeq: seq });
  });

  app.get("/rooms/:id", async (c) => {
    // Rol yanıta giriyor: UI izleyici modunu buna göre kuruyor. Yetki yine
    // sunucuda — bu alan sadece kullanıcıyı boşuna denemekten kurtarıyor.
    const { role } = await requireRoom(c, c.req.param("id"));
    const { room } = await mustFindRoom(c.req.param("id"));
    const session = await latestSession(room.id);
    const status = session?.containerId ? await containerStatus(session.containerId) : null;
    return c.json({ room, role, session, container: session?.containerId ? { status } : null });
  });

  /**
   * Snapshot — yeni katılan `since=0`'dan replay YAPMAZ.
   *
   * Davet linkine tıklayan kişi bunu alır, sonra `?since=seq` ile SSE'ye
   * bağlanır. Snapshot yoksa Hafta 3'teki tam replay yolu devreye girer.
   */
  app.get("/rooms/:id/snapshot", async (c) => {
    await requireRoom(c, c.req.param("id"));
    const { room } = await mustFindRoom(c.req.param("id"));
    const session = await latestSession(room.id);
    if (!session) throw new HttpError(404, "bu odanın oturumu yok");

    const stored = await latestSnapshot(session.id);
    if (!stored) return c.json({ state: null, seq: 0, version: SNAPSHOT_VERSION });
    return c.json({ state: stored.state, seq: stored.seq, version: stored.version });
  });

  /**
   * Tek endpoint, iki kip — yol haritasındaki sözleşme korunuyor:
   * `Accept: text/event-stream` ise SSE, değilse sayfalanmış JSON.
   */
  app.get("/rooms/:id/events", async (c) => {
    const { user } = await requireRoom(c, c.req.param("id"));
    const { room } = await mustFindRoom(c.req.param("id"));
    const session = await latestSession(room.id);
    if (!session) throw new HttpError(404, "bu odanın oturumu yok");

    if (wantsSse(c)) {
      return streamSession(c, {
        sessionId: session.id,
        since: resolveSince(c),
        roomId: room.id,
        user: { userId: user.id, name: user.name },
      });
    }

    const q = EventsQuery.safeParse({
      since: c.req.query("since") ?? 0,
      limit: c.req.query("limit") ?? 500,
    });
    if (!q.success) throw new HttpError(400, "since/limit geçersiz");

    const events = await readEvents(session.id, q.data);
    return c.json({
      sessionId: session.id,
      since: q.data.since,
      lastSeq: events.length > 0 ? events[events.length - 1]!.seq : q.data.since,
      // İstemci bu false olana kadar sayfalar, sonra SSE'yi açar.
      hasMore: events.length === q.data.limit,
      events,
    });
  });

  /**
   * Bakılan agent değişti. Presence event log'a YAZILMAZ — bu uç hiçbir şey
   * append etmez, sadece bellekteki kaydı günceller ve yayını tetikler.
   */
  app.post("/rooms/:id/presence", async (c) => {
    const roomId = c.req.param("id");
    const { user } = await requireRoom(c, roomId);
    const body = PresenceBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw new HttpError(400, "viewing alanı geçersiz");
    setViewing(roomId, user.id, body.data.viewing ?? null, body.data.connectionId ?? null);
    return c.json({ ok: true, people: listPresence(roomId) });
  });

  app.get("/rooms/:id/presence", async (c) => {
    const roomId = c.req.param("id");
    await requireRoom(c, roomId);
    return c.json({ people: listPresence(roomId) });
  });

  /**
   * Odanın üyeleri ve rolleri. Sürücü devri bunu kullanır: "Devret → kişi
   * seç" iki tık olacaksa istemci kime devredebileceğini bir istekte görmeli.
   */
  app.get("/rooms/:id/members", async (c) => {
    await requireRoom(c, c.req.param("id"));
    return c.json({ members: await listMembers(c.req.param("id")) });
  });

  /** Rol değiştirme yalnızca oda sahibinin işi: izleyiciyi katılımcı yapmak. */
  app.patch("/rooms/:id/members/:userId", async (c) => {
    await requireRoom(c, c.req.param("id"), "owner");
    const body = MemberRoleBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw new HttpError(400, "role alanı geçersiz (owner|member|viewer)");

    const userId = c.req.param("userId");
    if (!Uuid.safeParse(userId).success) throw new HttpError(400, "kullanıcı kimliği UUID değil");

    const res = await setMemberRole(c.req.param("id"), userId, body.data.role as Role);
    if (!res.changed) {
      if (res.reason === "not_member") throw new HttpError(404, "bu kişi odanın üyesi değil");
      // Odayı sahipsiz bırakmak bir ayar değil, bir kaza olurdu.
      throw new HttpError(409, "odanın son sahibinin rolü düşürülemez");
    }
    return c.json({ userId, role: body.data.role });
  });

  app.get("/rooms/:id/journal", async (c) => {
    await requireRoom(c, c.req.param("id"));
    const { room, config } = await mustFindRoom(c.req.param("id"));
    const roomRoot = path.join(cfg.roomsDataDir, room.id);
    return c.json(await readJournal(roomRoot, config));
  });

  // --- agent uçları (Hafta 2) ----------------------------------------------

  app.get("/rooms/:id/agents", async (c) => {
    await requireRoom(c, c.req.param("id"));
    const { room, config } = await mustFindRoom(c.req.param("id"));
    const runtime = await listRuntime(room.id);
    const byName = new Map(runtime.map((r) => [r.agentName, r]));
    return c.json({
      agents: config.agents.map((a) => ({
        name: a.name,
        workspace: a.workspace,
        model: cfg.agent.modelOverride || a.model,
        toolsAllow: a.toolsAllow,
        toolsDeny: a.toolsDeny,
        runtime: byName.get(a.name) ?? null,
      })),
    });
  });

  app.post("/rooms/:id/agents/:aid/start", async (c) => {
    await requireRoom(c, c.req.param("id"), "owner");
    const { room } = await mustFindRoom(c.req.param("id"));
    const agentName = c.req.param("aid");
    const mgr = requireManager();
    try {
      const status = await mgr.start(room.id, agentName);
      return c.json({ agent: agentName, status }, 202);
    } catch (err) {
      // Ayağa kalkamama SEBEBİ kullanıcıya gider: "starting"de asılı kalmak
      // veya çıplak 500 görmek, ekrana bakan kişiye hiçbir şey anlatmıyor.
      // Anahtar eksikliği bir SUNUCU YAPILANDIRMA sorunu (503); container'ın
      // ayağa kalkmaması odanın durumu (409). Aynı kodu döndürmek, arayüzün
      // ikisine de "odayı yeniden aç" demesi demekti.
      if (err instanceof AgentCredentialsError) throw new HttpError(503, err.message);
      if (err instanceof AgentStartError) throw new HttpError(409, err.message);
      if (err instanceof AgentNotFoundError) throw new HttpError(404, err.message);
      throw err;
    }
  });

  app.post("/rooms/:id/agents/:aid/stop", async (c) => {
    await requireRoom(c, c.req.param("id"), "owner");
    const { room } = await mustFindRoom(c.req.param("id"));
    const agentName = c.req.param("aid");
    await requireManager().stop(room.id, agentName);
    return c.json({ agent: agentName, status: "stopped" }, 202);
  });

  /**
   * Mesaj, kuyruk, sürücü ve kesme uçları `routes/messages.ts`,
   * `routes/driver.ts` ve `routes/interrupt.ts` içinde (Hafta 5).
   *
   * Hafta 2'deki doğrudan "mesaj gönder" yolu buradan KALDIRILDI: iki giriş
   * kapısı olsaydı "agent başına tek koşan mesaj" garantisi ikisinin
   * arasından sızardı. Tek kapı kuyruk.
   */
  if (!queue) {
    app.post("/rooms/:id/agents/:aid/message", () => {
      throw new HttpError(503, "agent koşumu kapalı — hiçbir koşum ortamı tanımlı değil");
    });
  }

  app.post("/rooms/:id/stop", async (c) => {
    const { user } = await requireRoom(c, c.req.param("id"), "owner");
    const { room } = await mustFindRoom(c.req.param("id"));
    const event = await closeRoom({ roomId: room.id, actor: actorOf(user) });
    return c.json({ stopped: true, event: event ? { seq: event.seq, type: event.type } : null });
  });

  /**
   * SADECE geliştirme. Hafta 1 kapısının "elle event yazıp since=N ile geri oku"
   * maddesi bunu kullanır; Hafta 2'den itibaren event'leri agent runtime üretir.
   * Üretimde uç hiç tanımlanmaz — 404 döner.
   */
  if (process.env.NODE_ENV !== "production") {
    /**
     * SADECE SAHTE koşum ortamında: agent'ı `failed` durumuna düşür.
     *
     * Gerçekte buraya gelmek için runner'ın 3 kez çökmesi ve yeniden
     * başlatma hakkının bitmesi gerekiyor. Kapı "agent failed olunca kuyruk
     * temizleniyor" kontrolünü bunun üzerinden koşuyor; gerçek runner'la
     * aynı yol `week5-agent-gate.sh` içinde üç kez öldürerek test edilir.
     */
    app.post("/rooms/:id/agents/:aid/fail", async (c) => {
      await requireRoom(c, c.req.param("id"), "owner");
      const mgr = requireManager();
      if (!(mgr instanceof FakeAgentRuntime)) {
        throw new HttpError(409, "bu uç yalnızca sahte koşum ortamında çalışır");
      }
      const { room } = await mustFindRoom(c.req.param("id"));
      await mgr.forceFail(room.id, c.req.param("aid"), "kapı testi: agent düşürüldü");
      return c.json({ agent: c.req.param("aid"), status: "failed" }, 202);
    });

    app.post("/sessions/:sid/events", async (c) => {
      const sid = c.req.param("sid");
      if (!Uuid.safeParse(sid).success) throw new HttpError(400, "oturum kimliği UUID değil");
      const session = await getSession(sid);
      if (!session) throw new HttpError(404, "oturum bulunamadı");
      // Geliştirme ucu da yetkisiz değil: odanın sahibi olmayan event yazamaz.
      const { user } = await requireRoom(c, session.roomId, "owner");

      const raw = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      // seq ve ts sunucunun; roomId oturumdan gelir. Çağıran sadece type + payload verir.
      const parsed = NewRoomEvent.safeParse({
        roomId: session.roomId,
        sessionId: session.id,
        actor: raw.actor ?? actorOf(user),
        type: raw.type,
        payload: raw.payload,
      });
      if (!parsed.success) {
        throw new HttpError(
          400,
          "event şemaya uymuyor",
          parsed.error.issues.map((i) => `${i.path.join(".") || "<kök>"}: ${i.message}`),
        );
      }

      return c.json(await appendEvent(parsed.data), 201);
    });
  }

  app.notFound((c) => c.json({ error: "böyle bir uç yok" }, 404));

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      /**
       * 4xx'i SUNUCU LOGUNA yaz (üretim dışında).
       *
       * Elle test ederken "403 alıyorum" demek yetmiyor: hangi uç olduğu
       * görünmeden hata aranamıyor. Tarayıcı ağ sekmesine bakmak zorunda
       * kalmak, sunucunun bildiği bir şeyi kullanıcıya aratmaktır.
       */
      if (process.env.NODE_ENV !== "production" && err.status >= 400) {
        console.warn(`${err.status} ${c.req.method} ${new URL(c.req.url).pathname} — ${err.message}`);
      }
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
