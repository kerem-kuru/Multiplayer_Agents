/**
 * Entropi taramasının ASLA bayraklamayacağı şeyler.
 *
 * Yanlış pozitif, kaçırılan secret kadar zararlıdır: ekip aracı kapatır ya da
 * `[redacted:...]` yığınının arasında gerçek çıktıyı okuyamaz. Buradaki her
 * madde bir test dosyasındaki gerçek bir negatif örneğe karşılık gelir.
 */

/** Git nesne kimlikleri: sha1 (40) ve sha256 (64) hex. */
const GIT_SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;

/** UUID (davet token'ı değil — onu kural seti yakalar). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ISO 8601 tarih/saat. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** Gömülü dosya verisi — base64 sihirli önekleri. */
const BASE64_MAGIC = [
  "iVBORw0KGgo", // PNG
  "/9j/", // JPEG
  "R0lGOD", // GIF
  "JVBERi0", // PDF
  "UEsDB", // zip / xlsx / docx
  "AAABAA", // ico
  "data:",
];

/** İçerik hash'i bağlamı: bu kelimelerin yanındaki hex bir secret değildir. */
const HASH_CONTEXT = /(sha\d*|hash|digest|commit|checksum|etag|integrity|revision)/i;

/** Yalnızca hex ve uzunluğu 32'nin katı. */
const HEX_BLOCK = /^[0-9a-f]+$/i;

/** Semver, derleme numarası, port gibi sayı ağırlıklı ama düşük çeşitlilikli. */
const NUMERIC_ISH = /^[0-9._-]+$/;

/** Subresource Integrity / paket kilidi: `sha512-<base64>`. Ölçüm: entropi 4.99. */
const SRI = /^(?:sha\d{1,3}|md5)-/i;

/** MIME çok parçalı gövde ayracı — `boundary=----WebKitFormBoundary...`. */
const BOUNDARY_CONTEXT = /boundary\s*=\s*$/i;

export interface AllowContext {
  /** Token'ın solundaki metin (bağlam kararları için). */
  prefix: string;
}

/**
 * Yol mu?
 *
 * `/` içeren token'lar tokenizer'a takılıyor (`/room/worktrees/...`). Ama
 * "`/` varsa yoldur" demek OLMAZ: AWS secret'ı da `/` içeriyor
 * (`wJalrXUtnFEMI/K7MDENG/bPxRf...`) ve onu kaçırırdık — ölçerek gördük.
 *
 * Ayırt edici: yol parçaları küçük harfli isimlerdir; base64 gövdesi karışık
 * büyük/küçük harf taşır. Bir parçada bile büyük harf varsa yol saymıyoruz.
 */
function looksLikePath(token: string): boolean {
  if (!token.includes("/")) return false;
  return token
    .split("/")
    .filter((part) => part.length > 0)
    .every((part) => /^[a-z0-9_.@+-]+$/.test(part));
}

export function isAllowlisted(token: string, ctx: AllowContext): boolean {
  if (GIT_SHA.test(token)) return true;
  if (UUID.test(token)) return true;
  if (ISO_DATE.test(token)) return true;
  if (NUMERIC_ISH.test(token)) return true;
  if (looksLikePath(token)) return true;
  if (BASE64_MAGIC.some((m) => token.startsWith(m))) return true;
  if (SRI.test(token)) return true;
  if (BOUNDARY_CONTEXT.test(ctx.prefix)) return true;
  // `data:image/png;base64,....` — sihirli önek token'ın solunda kalmış olabilir.
  if (/base64,\s*$/i.test(ctx.prefix)) return true;
  if (HEX_BLOCK.test(token) && token.length % 32 === 0 && HASH_CONTEXT.test(ctx.prefix)) return true;
  return false;
}
