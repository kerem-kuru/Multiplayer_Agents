import { Hono, type Context } from "hono";
import { z } from "zod";
import { AgentQueue, ReviewError, setCommentResolved, submitReview } from "@agent-rooms/core";
import { HttpError } from "../http-error.js";
import { requireRoom } from "../auth/guard.js";

/**
 * İnceleme ve yorum uçları.
 *
 * Yetki SUNUCUDA: `member`+ yorum bırakır ve çözer, `viewer` yalnızca görür.
 * İstemcinin `+` düğmesini gizlemesi yetki değildir.
 */

const CommentBody = z
  .object({
    path: z.string().min(1),
    side: z.enum(["new", "old"]),
    line: z.number().int().positive(),
    /** Yorumcunun gördüğü satır — çapanın yarısı. Kırpılmadan gelir. */
    lineText: z.string(),
    body: z.string().min(1).max(4000),
    /** Yorumcunun gördüğü `diff.updated`'ın seq'i. */
    diffSeq: z.number().int().positive(),
  })
  .strict();

const ReviewBody = z.object({ comments: z.array(CommentBody).min(1).max(20) }).strict();

/** `ReviewError` HTTP durumunu kendisi taşıyor: burada çeviri uydurulmuyor. */
function asHttp(err: unknown): never {
  if (err instanceof ReviewError) {
    throw new HttpError(
      err.status as 400,
      err.message,
      err.detail ? [JSON.stringify(err.detail)] : [],
    );
  }
  throw err;
}

export function reviewRoutes(queue: AgentQueue) {
  const app = new Hono();

  /**
   * İncelemeyi gönder: 1–20 yorum, tek turn.
   *
   * Yanıt `202 { reviewId, messageId, position }`. Turn'ün bitmesi
   * beklenmez; ilerleme event log'dan izlenir.
   */
  app.post("/rooms/:id/agents/:aid/reviews", async (c) => {
    const roomId = c.req.param("id");
    const agentName = c.req.param("aid");
    const { user } = await requireRoom(c, roomId, "member");

    const parsed = ReviewBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      throw new HttpError(
        400,
        "istek gövdesi geçersiz",
        parsed.error.issues.map((i) => `${i.path.join(".") || "<kök>"}: ${i.message}`),
      );
    }

    try {
      const res = await submitReview(
        roomId,
        agentName,
        { id: user.id, name: user.name },
        parsed.data.comments,
        queue,
      );
      return c.json({ ...res, agent: agentName }, 202);
    } catch (err) {
      asHttp(err);
    }
  });

  /**
   * Çöz / yeniden aç. Durum İNSAN kararıdır — agent bir yorumu kapatamaz,
   * cevabında uyguladığını söyleyebilir.
   */
  const toggle = (resolved: boolean) => async (c: Context) => {
    // Genel `Context` yol parametrelerini `string | undefined` veriyor;
    // rota kalıbı ikisini de garanti ediyor ama tip bunu bilmiyor.
    const roomId = c.req.param("id") ?? "";
    const commentId = c.req.param("cid") ?? "";
    const { user } = await requireRoom(c, roomId, "member");
    try {
      const res = await setCommentResolved(
        roomId,
        commentId,
        { id: user.id, name: user.name },
        resolved,
      );
      return c.json({ commentId, resolved, agent: res.agentName });
    } catch (err) {
      asHttp(err);
    }
  };

  app.post("/rooms/:id/comments/:cid/resolve", toggle(true));
  app.post("/rooms/:id/comments/:cid/reopen", toggle(false));

  return app;
}
