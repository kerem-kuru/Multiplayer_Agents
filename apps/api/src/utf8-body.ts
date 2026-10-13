import type { MiddlewareHandler } from "hono";
import { HttpError } from "./http-error.js";

/**
 * Gövde ayrıştırmanın TEK geçidi: geçersiz UTF-8 reddedilir, ikame edilmez.
 *
 * NEDEN: `c.req.json()` (Web `Request.json()`) geçersiz baytı sessizce U+FFFD
 * yapıyor. Git'in curl'ü `-d` argümanını Windows kod sayfasıyla gönderdiği için
 * kapıların Türkçe mesajları üç hafta boyunca modele "olu�tur" diye gitti, API
 * her birine 201 verdi (13 Ekim, ölçüldü). Bozuk veriyi kabul edip log'a yazmak
 * yerine gönderene söylüyoruz: JSON zaten UTF-8 olmak ZORUNDA (RFC 8259 §8.1).
 *
 * NEDEN MIDDLEWARE: uçlar gövdeyi `c.req.json().catch(() => ({}))` ile okuyor;
 * kontrol oraya konsa `.catch` yutardı. Burada bir kez okunuyor, Hono gövdeyi
 * önbelleğe aldığı için uçlardaki `c.req.json()` aynı (artık doğrulanmış)
 * baytları okuyor. Yeni bir uç bu geçidi unutamaz.
 *
 * BİLİNÇLİ İSTİSNA — "önce kimlik, sonra doğrulama" (Hafta 4): kimlik uçların
 * içinde soruluyor, bu geçit ondan ÖNCE çalışıyor. Kimliksiz ve bozuk gövdeli
 * istek 401 yerine 400 alır. Kuralın amacı (alan adlarını, oda kimliklerini
 * yetkisize sızdırmamak) bozulmuyor: baytların geçerli UTF-8 olup olmadığı
 * sunucu hakkında hiçbir şey söylemiyor. Test bunu sabitliyor.
 */
const UTF8_LABELS = new Set(["utf-8", "utf8"]);

export const requireUtf8Body: MiddlewareHandler = async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD" || c.req.raw.body === null) {
    return next();
  }

  const charset = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(c.req.header("content-type") ?? "")?.[1];
  if (charset !== undefined && !UTF8_LABELS.has(charset.toLowerCase())) {
    throw new HttpError(400, `gövde kodlaması UTF-8 olmalı (charset=${charset})`);
  }

  const bytes = await c.req.arrayBuffer();
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new HttpError(400, "gövde geçerli UTF-8 değil");
  }
  return next();
};
