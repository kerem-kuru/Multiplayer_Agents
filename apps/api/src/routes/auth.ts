import { Hono } from "hono";
import { z } from "zod";
import { HttpError } from "../http-error.js";
import {
  consumeMagicLink,
  findOrCreateUser,
  issueMagicLink,
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

    /**
     * E-POSTA GÖNDERİMİ HENÜZ YOK (Faz 3).
     *
     * `AUTH_DEV_MODE` kapalıyken bu uç eskiden `{ ok: true }` dönüyordu ve
     * ekranda "adresine bir bağlantı gönderdik" yazıyordu — hiçbir bağlantı
     * gitmediği için giriş imkânsızdı ve arayüz kullanıcıya YALAN söylüyordu.
     * Gerçekte oldu: `npm run dev:all` bu değişkeni geçirmiyor, elle test
     * eden kişi bekleyen bir e-posta sandı.
     *
     * Gönderici kurulduğunda bu dal gerçek gönderime bağlanır; o güne kadar
     * "yapamıyorum" demek doğrusu.
     */
    if (!cfg.authDevMode) {
      throw new HttpError(
        503,
        "e-posta gönderimi henüz kurulmadı: sunucuyu AUTH_DEV_MODE=true ile koş " +
          "(giriş bağlantısı ekranda ve sunucu logunda görünür)",
      );
    }

    const link = await issueMagicLink(body.data.email, cfg.appBaseUrl, body.data.next);
    // Geliştirme kolaylığı: linki hem loga hem yanıta koy.
    console.log(`giriş bağlantısı (${body.data.email}): ${link.url}`);
    return c.json({ ok: true, devLink: link.url, expiresAt: link.expiresAt });
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
