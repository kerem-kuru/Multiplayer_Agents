import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { appendEvent, currentView, latestSession } from "@agent-rooms/core";
import type { NewRoomEvent } from "@agent-rooms/protocol";
import { HttpError } from "../http-error.js";
import { requireRoom, setMemberRole } from "../auth/guard.js";

/**
 * Yetki isteği — izleyicinin "beni katılımcı yap" yolu.
 *
 * Hafta 5'in borcuydu: izleyici satırı ne olduğunu VE nasıl değişeceğini
 * söylüyordu ("oda sahibi seni katılımcı yaparsa…") ama o cümleyi eyleme
 * çevirecek tek bir tık yoktu. Kullanıcıya ne yapması gerektiğini söyleyip
 * yapma yolunu vermemek, bilgiyi tavsiyeye çeviriyor.
 *
 * TEK GERÇEK KAYNAK EVENT LOG. İstekler ayrı bir tabloda tutulmuyor; durum
 * `project()` üzerinden okunuyor. Ayrı tablo, "tabloda bekliyor ama log'da
 * çözülmüş" gibi bir çelişkiyi mümkün kılardı.
 */

const RequestBody = z
  .object({ note: z.string().trim().max(280).optional() })
  .strict();

const ResolveBody = z.object({ decision: z.enum(["granted", "denied"]) }).strict();

export function accessRoutes() {
  const app = new Hono();

  const sessionOf = async (roomId: string): Promise<string> => {
    const session = await latestSession(roomId);
    if (!session) throw new HttpError(404, "bu odanın oturumu yok");
    return session.id;
  };

  /**
   * İstekleri herkes görür: izleyici kendi isteğinin beklediğini, sahip de
   * kararını bekleyenleri. Gizlenecek bir şey yok — oda zaten ortak.
   */
  app.get("/rooms/:id/access-requests", async (c) => {
    const roomId = c.req.param("id");
    await requireRoom(c, roomId);
    const { view } = await currentView(await sessionOf(roomId));
    return c.json({ requests: view.access });
  });

  /**
   * İzleyici yetki ister. `member` ve üstü zaten yazabiliyor: onlara 409
   * dönmek, "isteğin anlamsız" demenin dürüst yolu.
   */
  app.post("/rooms/:id/access-requests", async (c) => {
    const roomId = c.req.param("id");
    const { user, role } = await requireRoom(c, roomId);
    if (role !== "viewer") {
      throw new HttpError(409, "zaten yazma yetkin var — istek gerekmiyor");
    }

    const parsed = RequestBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new HttpError(400, "not alanı geçersiz (en fazla 280 karakter)");

    const sessionId = await sessionOf(roomId);
    const { view } = await currentView(sessionId);

    /**
     * Açık istek varken ikincisi yazılmıyor. İki kez basmak sahibe iki satır
     * göstermezdi ama event log'a iki kayıt düşerdi ve "hangisini çözdüm"
     * sorusu doğardı.
     */
    const open = view.access.find((r) => r.user.id === user.id && r.state === "pending");
    if (open) return c.json({ requestId: open.requestId, state: "pending", existing: true }, 200);

    const requestId = randomUUID();
    await appendEvent({
      roomId,
      sessionId,
      actor: { kind: "human", id: user.id, name: user.name },
      type: "access.requested",
      payload: {
        requestId,
        user: { id: user.id, name: user.name },
        role: "member",
        note: parsed.data.note?.length ? parsed.data.note : null,
      },
    } satisfies NewRoomEvent);

    return c.json({ requestId, state: "pending", existing: false }, 202);
  });

  /**
   * Sahip karar verir. `granted` ise rol ÖNCE değiştirilir, event SONRA
   * yazılır: event "oldu" demektir, "olacak" demek değil. Ters sırada bir
   * hata, log'da olmuş görünen ama gerçekleşmemiş bir yetki bırakırdı.
   */
  app.post("/rooms/:id/access-requests/:rid", async (c) => {
    const roomId = c.req.param("id");
    const requestId = c.req.param("rid");
    const { user: by } = await requireRoom(c, roomId, "owner");

    const parsed = ResolveBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new HttpError(400, "decision alanı geçersiz (granted|denied)");

    const sessionId = await sessionOf(roomId);
    const { view } = await currentView(sessionId);
    const req = view.access.find((r) => r.requestId === requestId);
    if (!req) throw new HttpError(404, "böyle bir yetki isteği yok");
    if (req.state !== "pending") {
      throw new HttpError(409, `bu istek zaten ${req.state === "granted" ? "kabul" : "ret"} edildi`);
    }

    if (parsed.data.decision === "granted") {
      const res = await setMemberRole(roomId, req.user.id, "member");
      if (!res.changed && res.reason === "not_member") {
        throw new HttpError(404, "bu kişi odanın üyesi değil");
      }
    }

    await appendEvent({
      roomId,
      sessionId,
      actor: { kind: "human", id: by.id, name: by.name },
      type: "access.resolved",
      payload: {
        requestId,
        decision: parsed.data.decision,
        user: req.user,
        by: { id: by.id, name: by.name },
      },
    } satisfies NewRoomEvent);

    return c.json({ requestId, decision: parsed.data.decision });
  });

  return app;
}
