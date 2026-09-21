import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { CommentSide, NewRoomEvent } from "@agent-rooms/protocol";
import { lineAt, type AgentView } from "@agent-rooms/view";
import { appendEvent } from "./db/eventStore.js";
import { getPool } from "./db/pool.js";
import { AgentQueue, QueueError, REVIEW_MAX_COMMENTS, type QueuedReviewComment, type QueueUser } from "./queue.js";
import { currentView } from "./snapshot.js";
import { getRoomConfig, latestSession } from "./room/rooms.js";

/**
 * Satır yorumları ve incelemeler.
 *
 * İKİ KURAL BURADA YAŞIYOR:
 *
 * 1. **Agent'a giden metin sunucuda kurulur.** İstemci hazır prompt
 *    göndermez; sunucu `reviews` kaydından dosya yolu, satır numarası ve
 *    alıntılanan satırla metni kendisi üretir (`buildReviewPrompt`). Aksi
 *    hâlde event log'daki kayıt ile agent'ın duyduğu şey ayrışabilirdi.
 *
 * 2. **Çapa sunucuda doğrulanır.** İstemci "42. satıra yazdım" diyemez;
 *    sunucu o anki patch'te o satırın GERÇEKTEN var olduğunu ve metninin
 *    birebir aynı olduğunu kontrol eder. Düğmeyi gizlemek yetki olmadığı
 *    gibi, istemcinin satır iddiası da kanıt değildir.
 */

export interface DraftComment {
  path: string;
  side: CommentSide;
  line: number;
  lineText: string;
  body: string;
  /** Yorumcunun gördüğü `diff.updated`'ın seq'i. */
  diffSeq: number;
}

export class ReviewError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ReviewError";
  }
}

/** Yorum gövdesinin üst sınırı — event şeması da aynı sınırı koyuyor. */
export const COMMENT_MAX_BODY = 4000;

/**
 * Agent'ın projeksiyonu.
 *
 * Hiç event üretmemiş bir agent (YAML'da var ama başlatılmamış) için
 * projeksiyonda satır YOKTUR. Bu "agent bulunamadı" demek değil — "henüz
 * diff'i yok" demek. İkisini karıştırmak, ekranda "backend diye bir agent yok"
 * yazarken YAML'da gözükmesi gibi anlaşılmaz bir hâl üretiyordu.
 */
async function agentView(roomId: string, agentName: string, pool: pg.Pool): Promise<AgentView> {
  const config = await getRoomConfig(roomId, pool);
  if (config && !config.agents.some((a) => a.name === agentName)) {
    throw new ReviewError(404, `agent YAML'da yok: ${agentName}`);
  }
  const session = await latestSession(roomId, pool);
  if (!session) throw new ReviewError(404, "odanın oturumu yok");
  const { view } = await currentView(session.id, pool);
  const agent = view.agents[agentName];
  if (!agent) {
    throw new ReviewError(409, `${agentName} henüz hiç çalışmadı — diff yok, yorum bırakılamaz`);
  }
  return agent;
}

/**
 * Yorumların çapasını o anki diff'e karşı doğrula.
 *
 * Tek gerçek kaynak EVENT LOG: doğrulama `project()` üzerinden yapılıyor,
 * ayrı bir diff önbelleği tutulmuyor. İkinci bir kaynak olsaydı "sunucunun
 * gördüğü diff" ile "herkesin gördüğü diff" ayrılabilirdi.
 */
function validateAnchors(agent: AgentView, comments: DraftComment[]): void {
  comments.forEach((c, commentIndex) => {
    const fail = (reason: string): never => {
      throw new ReviewError(400, reason, { commentIndex, reason });
    };

    if (c.body.trim().length === 0) fail("yorum gövdesi boş");
    if (c.body.length > COMMENT_MAX_BODY) fail(`yorum ${COMMENT_MAX_BODY} karakteri aşıyor`);

    /**
     * `diffSeq` bu agent'ın gördüğü bir diff yayımına ait olmalı ve
     * yorumcunun gördüğü hâlden ESKİ olmamalı. 0 veya gelecekten bir seq,
     * istemcinin uydurduğu bir çapa demektir.
     */
    if (!Number.isInteger(c.diffSeq) || c.diffSeq <= 0) fail("diffSeq geçersiz");
    if (c.diffSeq > agent.diff.lastSeq) fail("diffSeq bu agent'ın diff'inden ileride");

    const file = agent.diff.files[c.path];
    if (!file) fail(`dosya diff'te yok: ${c.path}`);
    if (file!.patch === null) fail(`bu dosyanın patch'i yok (ikili dosya): ${c.path}`);

    const text = lineAt(file!.patch, c.side, c.line);
    if (text === null) fail(`${c.path}:${c.line} diff'te böyle bir satır yok`);
    /**
     * Metin birebir eşleşmeli. Kullanıcı yorumu yazarken satır değiştiyse
     * istemci bunu zaten göstermiş olmalı; sunucu yine de doğrular —
     * "sessizce yanlış satıra yapışmak" bu kontrolün olmadığı durumdur.
     */
    if (text !== c.lineText) fail(`${c.path}:${c.line} metni değişmiş`);
  });
}

export interface SubmitReviewResult {
  reviewId: string;
  messageId: string;
  position: number;
}

export async function submitReview(
  roomId: string,
  agentName: string,
  author: QueueUser,
  comments: DraftComment[],
  queue: AgentQueue,
  pool: pg.Pool = getPool(),
): Promise<SubmitReviewResult> {
  if (comments.length === 0) throw new ReviewError(400, "en az bir yorum gerekli");
  if (comments.length > REVIEW_MAX_COMMENTS) {
    throw new ReviewError(400, `bir incelemede en fazla ${REVIEW_MAX_COMMENTS} yorum olabilir`);
  }

  const agent = await agentView(roomId, agentName, pool);
  const baseCheckpointId = agent.diff.base?.checkpointId;
  if (!baseCheckpointId) throw new ReviewError(409, "bu agent'ın diff tabanı yok — yorum bırakılamaz");

  validateAnchors(agent, comments);

  const reviewId = randomUUID();
  const queued: QueuedReviewComment[] = comments.map((c) => ({
    commentId: randomUUID(),
    path: c.path,
    side: c.side,
    line: c.line,
    lineText: c.lineText,
    body: c.body,
    diffSeq: c.diffSeq,
  }));

  try {
    const res = await queue.enqueueReview(roomId, agentName, author, {
      reviewId,
      comments: queued,
      baseCheckpointId,
    });
    return { reviewId, ...res };
  } catch (err) {
    // Kuyruk kendi HTTP durumunu taşıyor; burada çeviri uydurulmuyor.
    if (err instanceof QueueError) throw new ReviewError(err.status, err.message, err.detail);
    throw err;
  }
}

/**
 * Yorumu çöz / yeniden aç.
 *
 * Durum İNSAN KARARIDIR: agent cevabında "uyguladım" diyebilir ama yorumu
 * kapatamaz. Bu yüzden ayrı bir tablo yok — durum event log'dan okunuyor ve
 * yazan her zaman bir insan.
 */
export async function setCommentResolved(
  roomId: string,
  commentId: string,
  by: QueueUser,
  resolved: boolean,
  pool: pg.Pool = getPool(),
): Promise<{ agentName: string }> {
  const session = await latestSession(roomId, pool);
  if (!session) throw new ReviewError(404, "odanın oturumu yok");
  const { view } = await currentView(session.id, pool);

  let agentName: string | null = null;
  let already = false;
  for (const [name, agent] of Object.entries(view.agents)) {
    const c = agent.comments.find((x) => x.commentId === commentId);
    if (!c) continue;
    agentName = name;
    already = c.resolved === resolved;
    break;
  }
  if (!agentName) throw new ReviewError(404, "böyle bir yorum yok");
  // Yarışı yut: iki kişi aynı anda çözerse event İKİ KEZ yazılmaz.
  if (already) return { agentName };

  await appendEvent(
    {
      roomId,
      sessionId: session.id,
      actor: { kind: "human", id: by.id, name: by.name },
      type: resolved ? "comment.resolved" : "comment.reopened",
      payload: { agent: agentName, commentId, by },
    } satisfies NewRoomEvent,
    pool,
  );
  return { agentName };
}
