import { Hono } from "hono";
import { AgentQueue, QueueError, getDriver } from "@agent-rooms/core";
import { HttpError } from "../http-error.js";
import { requireRoom } from "../auth/guard.js";

/**
 * Kesme ucu — YALNIZCA SÜRÜCÜ.
 *
 * Yetki sunucuda: düğmeyi gizlemek yetki değildir. Sürücü olmayan biri
 * mesaj yazabilir (kuyruğa girer) ama koşan turn'ü kesemez.
 *
 * Kesme ANINDA OLMAYABİLİR. Bu uç `interrupt.requested` yazıp döner; gerçek
 * duruş `interrupt.applied` ile gelir. UI aradaki süreyi "kesme kuyruğa
 * alındı" olarak gösterir — uzun bir bash komutunun ortasında anlık durdurma
 * sözü verilmiyor.
 */
export function interruptRoutes(queue: AgentQueue) {
  const app = new Hono();

  app.post("/rooms/:id/agents/:aid/interrupt", async (c) => {
    const roomId = c.req.param("id");
    const agentName = c.req.param("aid");
    const { user } = await requireRoom(c, roomId, "member");

    const driver = await getDriver(roomId, agentName);
    if (!driver) throw new HttpError(404, "agent bulunamadı");
    if (driver.user?.id !== user.id) {
      // Mevcut sürücüyü yanıtla söyle: "yetkin yok" tek başına ne yapacağını
      // anlatmıyor, kimden isteyeceğini anlatan bilgi lazım.
      throw new HttpError(403, "kesme yalnızca sürücüde", [
        JSON.stringify({ currentDriver: driver.user }),
      ]);
    }

    try {
      const messageId = await queue.interruptRunning(roomId, agentName, {
        id: user.id,
        name: user.name,
      });
      // 202: istek alındı, uygulanması ayrı bir event.
      return c.json({ requested: true, messageId, agent: agentName }, 202);
    } catch (err) {
      if (err instanceof QueueError) {
        throw new HttpError(err.status as 409, err.message);
      }
      throw err;
    }
  });

  return app;
}
