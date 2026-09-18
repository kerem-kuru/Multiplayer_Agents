import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Token üretimi ve karşılaştırması.
 *
 * DEĞİŞMEZ KURAL: ham token DB'de durmaz. Veritabanı sızarsa elde edilen şey
 * hash'lerdir; onlarla giriş yapılamaz.
 */

/** 32 bayt rastgele, base64url. URL'de ve çerezde güvenle taşınır. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Sabit zamanlı karşılaştırma.
 *
 * Aramayı hash sütunundan yapıyoruz (indeks), ama okunan değeri
 * karşılaştırırken zamanlama sızdırmayalım: uzunluk farkı bile bilgi verir.
 */
export function tokensMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Listede göstermek için: token'ın ilk 8 karakteri. Tek başına giriş sağlamaz. */
export function tokenPrefix(token: string): string {
  return token.slice(0, 8);
}
