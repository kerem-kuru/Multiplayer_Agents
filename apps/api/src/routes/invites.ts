import { Hono } from "hono";
import { z } from "zod";
import { getPool } from "@agent-rooms/core";
import { HttpError } from "../http-error.js";
import { addMember, requireRoom, requireUser } from "../auth/guard.js";
import { hashToken, newToken, tokenPrefix } from "../auth/tokens.js";
import type { ApiConfig } from "../config.js";

/**
 * Davet linki.
 *
 * Magic link'ten FARKLI: bu ÇOK KULLANIMLIK (ekibe tek link atılır), süreli
 * ve iptal edilebilir. Token DB'de yalnızca hash olarak durur; tam link
 * sadece oluşturma yanıtında bir kez görünür.
 *
 * Bu haftanın daveti sadece `viewer` üretir — izleyicinin yazma yetkisi
 * Hafta 5'in işi ve kuyruk olmadan verilirse iki mesaj paralel inference'a
 * girer.
 */

const CreateBody = z.object({
  expiresInHours: z.number().int().positive().max(24 * 30).optional(),
});

const AcceptBody = z.object({ token: z.string().min(10).max(200) });

const DEFAULT_HOURS = 24;

export function inviteRoutes(cfg: ApiConfig) {
  const app = new Hono();

  app.post("/rooms/:id/invites", async (c) => {
    const roomId = c.req.param("id");
    const { user } = await requireRoom(c, roomId, "owner");

    const body = CreateBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw new HttpError(400, "expiresInHours geçersiz");
    const hours = body.data.expiresInHours ?? DEFAULT_HOURS;

    const token = newToken();
    const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
    await getPool().query(
      `INSERT INTO room_invites (token_hash, token_prefix, room_id, role, created_by, expires_at)
       VALUES ($1, $2, $3, 'viewer', $4, $5)`,
      [hashToken(token), tokenPrefix(token), roomId, user.id, expiresAt],
    );

    const url = new URL("/join", cfg.appBaseUrl);
    url.searchParams.set("token", token);
    // Token YALNIZCA bu yanıtta görünür; DB'de hash'i var.
    return c.json({ url: url.toString(), prefix: tokenPrefix(token), expiresAt }, 201);
  });

  app.get("/rooms/:id/invites", async (c) => {
    const roomId = c.req.param("id");
    await requireRoom(c, roomId, "owner");

    const res = await getPool().query<{
      token_prefix: string;
      created_at: Date;
      expires_at: Date;
      revoked_at: Date | null;
    }>(
      `SELECT token_prefix, created_at, expires_at, revoked_at
         FROM room_invites WHERE room_id = $1 ORDER BY created_at DESC`,
      [roomId],
    );

    return c.json({
      invites: res.rows.map((r) => ({
        prefix: r.token_prefix,
        createdAt: r.created_at.toISOString(),
        expiresAt: r.expires_at.toISOString(),
        revokedAt: r.revoked_at?.toISOString() ?? null,
        active: r.revoked_at === null && r.expires_at.getTime() > Date.now(),
      })),
    });
  });

  app.delete("/rooms/:id/invites/:prefix", async (c) => {
    const roomId = c.req.param("id");
    await requireRoom(c, roomId, "owner");

    const res = await getPool().query(
      `UPDATE room_invites SET revoked_at = now()
        WHERE room_id = $1 AND token_prefix = $2 AND revoked_at IS NULL`,
      [roomId, c.req.param("prefix")],
    );
    if (res.rowCount === 0) throw new HttpError(404, "böyle bir aktif davet yok");
    return c.json({ ok: true });
  });

  /**
   * Daveti kabul et. Oturum yoksa `401` döner ve UI kullanıcıyı `next` ile
   * giriş sayfasına yollar; giriş sonrası buraya geri döner.
   */
  app.post("/invites/accept", async (c) => {
    const user = await requireUser(c);
    const body = AcceptBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw new HttpError(400, "token gerekli");

    const res = await getPool().query<{ room_id: string; role: "viewer" }>(
      `SELECT room_id, role FROM room_invites
        WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()`,
      [hashToken(body.data.token)],
    );
    const invite = res.rows[0];
    // Süresi dolmuş / iptal edilmiş / hiç olmamış — üçü de aynı cevap.
    if (!invite) throw new HttpError(400, "davet bağlantısı geçersiz veya süresi dolmuş");

    await addMember(invite.room_id, user.id, invite.role);
    return c.json({ roomId: invite.room_id, role: invite.role });
  });

  return app;
}
