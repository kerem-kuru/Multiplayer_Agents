import { Hono } from "hono";
import { z } from "zod";
import type { FileDiff, NewRoomEvent } from "@agent-rooms/protocol";
import {
  AgentManager,
  GitkitError,
  currentTree,
  diffFromCheckpoint,
  getCheckpoint,
  getRoomConfig,
  getRuntime,
  latestSession,
  listCheckpoints,
  makeCheckpoint,
  recordCheckpoint,
  roomContainerName,
} from "@agent-rooms/core";
import { HttpError } from "../http-error.js";
import { requireRoom } from "../auth/guard.js";

/**
 * Checkpoint ve isteğe bağlı diff uçları.
 *
 * HOST BU DEPODA GİT ÇALIŞTIRMAZ: buradaki her git işi `docker exec` ile
 * container içindeki gitkit'e gidiyor (bkz. `packages/core/src/diff.ts`).
 */

const CheckpointBody = z.object({ label: z.string().min(1).max(200) }).strict();

/**
 * İsteğe bağlı diff önbelleği.
 *
 * Anahtar `(oda, agent, taban, şu anki ağaç)`. Ağaç değişince anahtar da
 * değişiyor, yani bayat bir diff dönmek mümkün değil; önbellek yalnızca aynı
 * ana bakan tekrar istekleri ucuzlatıyor (iki kişi aynı anda aynı
 * karşılaştırmayı açtığında).
 */
const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; value: { baseTree: string; treeSha: string; files: FileDiff[] } }>();

const cacheGet = (key: string) => {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
};

export function checkpointRoutes(manager?: AgentManager) {
  const app = new Hono();

  /** Oda + agent → container adı ve container içi çalışma dizini. */
  const place = async (roomId: string, agentName: string) => {
    const config = await getRoomConfig(roomId);
    if (!config) throw new HttpError(500, "odanın konfigürasyonu okunamadı");
    const agent = config.agents.find((a) => a.name === agentName);
    if (!agent) throw new HttpError(404, `agent YAML'da yok: ${agentName}`);
    const session = await latestSession(roomId);
    if (!session) throw new HttpError(404, "bu odanın oturumu yok");
    return {
      container: session.containerId ?? roomContainerName(roomId),
      workdir: `/room/${agent.workspace}`,
      sessionId: session.id,
    };
  };

  /** Container'a ulaşılamadığında ham Docker hatası yerine ne yapılacağını söyle. */
  const asHttp = (err: unknown): never => {
    if (err instanceof GitkitError) throw new HttpError(409, err.message);
    if (/no such container/i.test(String(err)) || (err as { statusCode?: number }).statusCode === 404) {
      throw new HttpError(409, "odanın container'ı ayakta değil — odayı yeniden aç");
    }
    throw err;
  };

  app.get("/rooms/:id/agents/:aid/checkpoints", async (c) => {
    const roomId = c.req.param("id");
    await requireRoom(c, roomId);
    return c.json({ checkpoints: await listCheckpoints(roomId, c.req.param("aid")) });
  });

  /**
   * Manuel checkpoint: yeni TABAN olur.
   *
   * Agent boşta değilse `409`. Koşan bir turn'ün ortasında taban almak yarış
   * yaratır: runner o sırada eski tabana göre bir diff yayımlıyor olabilir ve
   * iki tabanın karışımı ekrana düşer.
   */
  app.post("/rooms/:id/agents/:aid/checkpoints", async (c) => {
    const roomId = c.req.param("id");
    const agentName = c.req.param("aid");
    const { user } = await requireRoom(c, roomId, "member");

    const parsed = CheckpointBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new HttpError(400, "label alanı geçersiz (1–200 karakter)");

    const rt = await getRuntime(roomId, agentName);
    if (rt?.status === "busy" || rt?.status === "starting") {
      throw new HttpError(409, `agent şu anda ${rt.status} — checkpoint için boşta olmalı`);
    }

    const { container, workdir, sessionId } = await place(roomId, agentName);
    let cp;
    try {
      cp = await makeCheckpoint(container, workdir, parsed.data.label);
    } catch (err) {
      asHttp(err);
    }

    // Event + `checkpoints` satırı + `agent_runtime.diff_base_checkpoint_id`
    // AYNI transaction'da.
    await recordCheckpoint({
      roomId,
      sessionId,
      actor: { kind: "human", id: user.id, name: user.name },
      type: "checkpoint.created",
      payload: {
        agent: agentName,
        checkpointId: cp!.checkpointId,
        kind: "manual",
        label: parsed.data.label,
        commitSha: cp!.commitSha,
        treeSha: cp!.treeSha,
        messageId: null,
        by: { id: user.id, name: user.name },
        becomesBase: true,
      },
    } satisfies NewRoomEvent);

    /**
     * Runner ayaktaysa yeni tabanı hemen öğrenir ve TAM diff yayımlar;
     * değilse bir sonraki başlangıçta ortam değişkeniyle alır. İki yol da
     * `agent_runtime.diff_base_checkpoint_id`'yi okuyor — tek kaynak.
     */
    manager?.setDiffBase(roomId, agentName, {
      checkpointId: cp!.checkpointId,
      treeSha: cp!.treeSha,
    });

    return c.json({ ...cp, kind: "manual", becomesBase: true }, 201);
  });

  /**
   * Canlı tabandan BAŞKA bir checkpoint'e göre diff.
   *
   * Event log'a YAZILMAZ: bu kullanıcıya özel bir görünüm, herkesin durumu
   * değil. Ama redaction'dan geçer — workspace içeriği sunan her yol geçer.
   *
   * CANLI DEĞİLDİR: istemci bunu açıkça yazmak zorunda ("Bu görünüm canlı
   * değil — yenile"). Canlı sanılan bayat bir diff, üzerine yorum yazılan
   * bir yalandır.
   */
  app.get("/rooms/:id/agents/:aid/diff", async (c) => {
    const roomId = c.req.param("id");
    const agentName = c.req.param("aid");
    await requireRoom(c, roomId);

    const from = c.req.query("from");
    if (!from) throw new HttpError(400, "from=<checkpointId> gerekli");
    const cp = await getCheckpoint(roomId, from);
    if (!cp || cp.agentName !== agentName) throw new HttpError(404, "böyle bir checkpoint yok");

    const { container, workdir } = await place(roomId, agentName);
    try {
      /**
       * Önce ŞU ANKİ AĞAÇ, sonra önbellek. Anahtarın içinde ağaç sha'sı
       * olmasaydı önbellek bayat bir diff dönebilirdi; ağaç değişince anahtar
       * da değişiyor. `tree` çağrısı kalıcı geçici index'i kullandığı için
       * yalnızca değişen dosyaları hash'liyor.
       */
      const tree = await currentTree(container, workdir);
      const key = `${roomId}:${agentName}:${from}:${tree}`;
      const cached = cacheGet(key);
      if (cached) return c.json({ ...cached, from, live: false, cached: true });

      const res = await diffFromCheckpoint(roomId, container, workdir, from);
      cache.set(key, { at: Date.now(), value: res });
      return c.json({ ...res, from, live: false, cached: false });
    } catch (err) {
      asHttp(err);
    }
  });

  return app;
}
