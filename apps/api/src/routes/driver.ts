import { Hono } from "hono";
import { z } from "zod";
import {
  DriverError,
  claimDriver,
  getDriver,
  handoffDriver,
  listDrivers,
  releaseDriver,
} from "@agent-rooms/core";
import { HttpError } from "../http-error.js";
import { listMembers, requireRoom } from "../auth/guard.js";

/**
 * Sürücü uçları.
 *
 * Sürücülük bir rol, bir kilit değil: sürücü olmayan da odayı kullanmaya
 * devam eder. Sürücünün fazladan iki yetkisi var — kesmek ve başkasının
 * kuyruk kaydını iptal etmek.
 *
 * DEVİR İKİ TIK: "Devret" → kişi seç. Üçüncü adım yok; bu yüzden istemcinin
 * kime devredebileceğini bir istekte görmesi gerekiyor (`GET .../driver`).
 */

const HandoffBody = z
  .object({
    toUserId: z.string().uuid(),
    /** İyimser kilit: istemcinin ekranda gördüğü sürüm. */
    version: z.number().int().nonnegative(),
  })
  .strict();

function asHttp(err: unknown): never {
  if (err instanceof DriverError) {
    throw new HttpError(
      err.status as 400,
      err.message,
      err.detail ? [JSON.stringify(err.detail)] : [],
    );
  }
  throw err;
}

export function driverRoutes() {
  const app = new Hono();

  /** Odadaki tüm sürücülükler — UI başlıktaki işareti bununla çiziyor. */
  app.get("/rooms/:id/drivers", async (c) => {
    const roomId = c.req.param("id");
    await requireRoom(c, roomId);
    return c.json({ drivers: await listDrivers(roomId) });
  });

  /**
   * Bir agent'ın sürücüsü + devredilebilecek kişiler.
   *
   * Aday listesi SUNUCUDAN gelir: yalnızca `member`/`owner` üyeler sürücü
   * olabilir ve bu kuralın tek kaynağı sunucu olmalı.
   */
  app.get("/rooms/:id/agents/:aid/driver", async (c) => {
    const roomId = c.req.param("id");
    const { user } = await requireRoom(c, roomId);
    const driver = await getDriver(roomId, c.req.param("aid"));
    if (!driver) throw new HttpError(404, "agent bulunamadı");
    const members = (await listMembers(roomId)).filter(
      (m) => m.role !== "viewer" && m.userId !== driver.user?.id,
    );
    return c.json({
      driver: driver.user,
      since: driver.since,
      version: driver.version,
      youAreDriver: driver.user?.id === user.id,
      candidates: members.map((m) => ({ userId: m.userId, name: m.name, role: m.role })),
    });
  });

  app.post("/rooms/:id/agents/:aid/driver/claim", async (c) => {
    const roomId = c.req.param("id");
    const { user } = await requireRoom(c, roomId, "member");
    try {
      const rec = await claimDriver(roomId, c.req.param("aid"), {
        id: user.id,
        name: user.name,
      });
      return c.json(rec);
    } catch (err) {
      asHttp(err);
    }
  });

  app.post("/rooms/:id/agents/:aid/driver/release", async (c) => {
    const roomId = c.req.param("id");
    const { user } = await requireRoom(c, roomId, "member");
    try {
      const rec = await releaseDriver(roomId, c.req.param("aid"), {
        id: user.id,
        name: user.name,
      });
      return c.json(rec);
    } catch (err) {
      asHttp(err);
    }
  });

  app.post("/rooms/:id/agents/:aid/driver/handoff", async (c) => {
    const roomId = c.req.param("id");
    const { user } = await requireRoom(c, roomId, "member");
    const body = HandoffBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw new HttpError(400, "toUserId ve version gerekli");

    /**
     * Hedef odanın `member`/`owner` üyesi olmalı. İzleyiciye sürücülük
     * devretmek, kesme yetkisini yazma yetkisi olmayan birine vermek olurdu.
     */
    const target = (await listMembers(roomId)).find((m) => m.userId === body.data.toUserId);
    if (!target || target.role === "viewer") {
      throw new HttpError(400, "hedef kişi odanın katılımcısı değil");
    }

    try {
      const rec = await handoffDriver(
        roomId,
        c.req.param("aid"),
        { id: user.id, name: user.name },
        { id: target.userId, name: target.name },
        body.data.version,
      );
      return c.json(rec);
    } catch (err) {
      asHttp(err);
    }
  });

  return app;
}
