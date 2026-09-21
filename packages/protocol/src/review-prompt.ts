import type { CommentSide } from "./diff.js";

/**
 * İnceleme → agent'a giden metin. SAF FONKSİYON, birim testlenebilir.
 *
 * Metin SUNUCUDA kuruluyor, istemcide değil: istemci hazır prompt gönderseydi
 * "agent'a ne söylendiği" tarayıcının insafına kalırdı ve event log'daki
 * `message.received.text` ile gerçekte gönderilen şey ayrışabilirdi.
 *
 * `[İsim]: ` önekini bu fonksiyon EKLEMEZ — onu kuyruk, mesajı runner'a
 * verirken koyuyor (Hafta 5 kuralı: event log'daki metin ham kalır).
 */

export interface ReviewComment {
  path: string;
  side: CommentSide;
  line: number;
  /** Yorumcunun gördüğü satır. Burada kırpılır, kaydında tam durur. */
  lineText: string;
  body: string;
}

/** Alıntılanan satırın üst sınırı. 800 karakterlik minified bir satır prompt'u boğar. */
export const LINE_TEXT_LIMIT = 200;

const clipLine = (text: string): string => {
  const flat = text.replace(/\r?\n/g, " ");
  return flat.length <= LINE_TEXT_LIMIT ? flat : `${flat.slice(0, LINE_TEXT_LIMIT)}…`;
};

/**
 * Yorumlar dosya yoluna, sonra satır numarasına göre sıralanır: agent
 * dosyada yukarıdan aşağı ilerlesin, oraya buraya zıplamasın.
 */
const order = (a: ReviewComment, b: ReviewComment): number =>
  a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1;

/**
 * @param authorName Yazan kişi. Metne GİRMEZ — `[İsim]: ` önekini kuyruk
 *   ekliyor ve iki kere yazmak agent'a aynı ismi iki farklı biçimde
 *   gösterirdi. İmzada duruyor çünkü çağıran taraf onu zaten elinde tutuyor
 *   ve ileride (Hafta 7, çok agent) metin kişiye göre değişebilir.
 */
export function buildReviewPrompt(authorName: string, comments: ReviewComment[]): string {
  void authorName;
  const sorted = [...comments].sort(order);
  const n = sorted.length;

  const blocks = sorted.map((c, i) => {
    /**
     * Silinen satıra yorum: agent "42. satır" deyince NEYİ kastettiğimizi
     * bilmeli. Silinmiş bir satırın numarası yeni dosyada başka bir şeye
     * denk gelir.
     */
    const where = c.side === "old" ? `${c.path}:${c.line} (silinen satır)` : `${c.path}:${c.line}`;
    return [`${i + 1}) ${where}`, `   > ${clipLine(c.lineText)}`, `   ${c.body}`].join("\n");
  });

  return [
    `Diff üzerine ${n} satır yorumu:`,
    "",
    blocks.join("\n\n"),
    "",
    "Her yorumu uygula. Uygulayamadığın veya katılmadığın bir yorum varsa, numarasıyla birlikte nedenini yaz.",
    "Satır numaraları yorumun yazıldığı andaki haline göredir; satır yer değiştirmiş olabilir, alıntılanan metni esas al.",
  ].join("\n");
}

/**
 * Kuyruk satırının ve etkinlik akışının gösterdiği kısa başlık:
 * "Ayşe'nin 3 yorumluk incelemesi".
 */
export function reviewSummary(authorName: string, count: number): string {
  return `${authorName} · ${count} yorumluk inceleme`;
}
