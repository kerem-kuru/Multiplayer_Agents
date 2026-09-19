import { Hono } from "hono";
import { z } from "zod";
import {
  AgentQueue,
  QueueError,
  claimDriver,
  getDriver,
  isDriver,
  listDrivers,
} from "@agent-rooms/core";
import { HttpError } from "../http-error.js";
import { requireRoom } from "../auth/guard.js";

/**
 * Mesaj kuyruğu uçları.
 *
 * Hafta 2'deki davranış (`409 busy`) KALKTI: mesaj artık her zaman kabul
 * edilir ve sıraya girer. İstemci "sıram geldi mi" diye karar VERMEZ; sadece
 * sunucunun bildirdiği sırayı gösterir.
 */

const MessageBody = z.object({ text: z.string().min(1) }).strict();

/** `QueueError` HTTP durumunu kendisi taşıyor: burada çeviri uydurulmuyor. */
function asHttp(err: unknown): never {
  if (err instanceof QueueError) {
    throw new HttpError(err.status as 400, err.message, err.detail ? [JSON.stringify(err.detail)] : []);
  }
  throw err;
}

export function messageRoutes(queue: AgentQueue) {
  const app = new Hono();

  /**
   * Mesajı kuyruğa ekle. `member`+ yetkisi ister — izleyici yazamaz.
   *
   * Yanıt `202 { messageId, position }`. Turn'ün bitmesi beklenmez; ilerleme
   * event log'dan izlenir.
   */
  app.post("/rooms/:id/agents/:aid/message", async (c) => {
    const roomId = c.req.param("id");
    const agentName = c.req.param("aid");
    const { user } = await requireRoom(c, roomId, "member");

    const parsed = MessageBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      throw new HttpError(
        400,
        "istek gövdesi geçersiz",
        parsed.error.issues.map((i) => `${i.path.join(".") || "<kök>"}: ${i.message}`),
      );
    }

    const me = { id: user.id, name: user.name };
    let result;
    try {
      result = await queue.enqueue(roomId, agentName, me, parsed.data.text);
    } catch (err) {
      asHttp(err);
    }

    /**
     * Odaya ilk yönergeyi veren kişi, sürücü boşsa OTOMATİK sürücü olur.
     *
     * Sürücüsüz bir oda kimsenin kesemediği bir oda demek: ilk mesajı yazan
     * kişi büyük olasılıkla yönü değiştirecek olan kişidir. Sürücü varsa
     * sessizce vazgeçilir — mesaj göndermek sürücülük kavgası açmamalı.
     */
    await claimDriver(roomId, agentName, me, { silent: true }).catch(() => undefined);

    return c.json({ ...result, agent: agentName }, 202);
  });

  /**
   * Kuyruk kaydını iptal et. Kendi kaydını herkes; başkasınınkini yalnızca
   * sürücü veya oda sahibi. Koşan mesaj `409` — o kesmedir.
   */
  app.delete("/rooms/:id/queue/:messageId", async (c) => {
    const roomId = c.req.param("id");
    const messageId = c.req.param("messageId");
    const { user, role } = await requireRoom(c, roomId, "member");

    // Hangi agent'ın sürücüsü olduğu kaydın kendisinden çıkar; o yüzden
    // sürücülük bilgisi odanın TÜM agent'ları için toplanıyor.
    const drivers = await listDrivers(roomId);
    const driverOfAny = drivers.some((d) => d.user?.id === user.id);

    try {
      const res = await queue.cancel(
        roomId,
        messageId,
        { id: user.id, name: user.name },
        {
          isDriver: driverOfAny,
          isOwner: role === "owner",
        },
      );
      return c.json({ cancelled: messageId, agent: res.agentName });
    } catch (err) {
      asHttp(err);
    }
  });

  /**
   * Kuyruğun görünür hâli. `viewer`+ — izleyici de kuyruğu GÖRÜR, sadece
   * yazamaz. UI ilk yüklemede bunu projeksiyondan da alabilir; bu uç hata
   * ayıklama ve doğrulama için.
   */
  app.get("/rooms/:id/agents/:aid/queue", async (c) => {
    const roomId = c.req.param("id");
    const agentName = c.req.param("aid");
    const { user } = await requireRoom(c, roomId);
    const [queueState, driver] = await Promise.all([
      queue.list(roomId, agentName),
      getDriver(roomId, agentName),
    ]);
    return c.json({
      ...queueState,
      driver: driver?.user ? { ...driver.user, since: driver.since, version: driver.version } : null,
      // İstemcinin "kesebilir miyim" sorusunun cevabı sunucudan gelir.
      youAreDriver: await isDriver(roomId, agentName, user.id),
    });
  });

  return app;
}
