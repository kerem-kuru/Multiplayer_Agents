import { Hono } from "hono";
import { z } from "zod";
import { HttpError } from "../http-error.js";
import {
  consumeMagicLink,
  findOrCreateUser,
  issueMagicLink,
  MAGIC_LINK_TTL_MINUTES,
} from "../auth/magic-link.js";
import {
  clearSessionCookie,
  createAuthSession,
  destroyAuthSession,
  readSessionCookie,
  writeSessionCookie,
} from "../auth/session.js";
import { currentUser } from "../auth/guard.js";
import type { ApiConfig } from "../config.js";

/**
 * Magic link akışı.
 *
 * Gerçek e-posta gönderimi Faz 3. Geliştirme modunda (`AUTH_DEV_MODE=true`)
 * link yanıtta ve sunucu logunda görünür; kapalıyken yanıt her zaman
 * `{ ok: true }` olur — "bu e-posta kayıtlı mı" bilgisi sızmasın.
 */

const RequestBody = z.object({
  email: z.string().email().max(320),
  next: z.string().max(500).optional(),
});

export function authRoutes(cfg: ApiConfig) {
  const app = new Hono();

  app.post("/auth/request", async (c) => {
    const body = RequestBody.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) throw new HttpError(400, "geçerli bir e-posta gerekli");

    const link = await issueMagicLink(body.data.email, cfg.appBaseUrl, body.data.next);

    if (cfg.authDevMode) {
      // Geliştirme kolaylığı: linki hem loga hem yanıta koy.
      console.log(`giriş bağlantısı (${body.data.email}): ${link.url}`);
      return c.json({ ok: true, devLink: link.url, expiresAt: link.expiresAt });
    }
    return c.json({ ok: true, expiresInMinutes: MAGIC_LINK_TTL_MINUTES });
  });

  app.get("/auth/callback", async (c) => {
    const token = c.req.query("token") ?? "";
    const email = await consumeMagicLink(token);
    if (!email) {
      // Süresi dolmuş, kullanılmış veya hiç var olmamış — üçü de aynı cevap.
      throw new HttpError(400, "bağlantı geçersiz veya süresi dolmuş");
    }

    const user = await findOrCreateUser(email);
    const session = await createAuthSession(user.id);
    writeSessionCookie(c, session.token, cfg.cookieSecure);

    const next = c.req.query("next");
    // Açık yönlendirme olmasın: sadece uygulama içi göreli yollar.
    const target = next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
    return c.redirect(target, 302);
  });

  app.post("/auth/logout", async (c) => {
    await destroyAuthSession(readSessionCookie(c));
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  app.get("/auth/me", async (c) => {
    const user = await currentUser(c);
    if (!user) throw new HttpError(401, "giriş gerekli");
    return c.json(user);
  });

  return app;
}
