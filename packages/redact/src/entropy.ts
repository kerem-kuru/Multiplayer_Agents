import { isAllowlisted } from "./allowlist.js";

/**
 * Entropi taraması — kural setinin kaçırdığı, formatı bilinmeyen secret'lar
 * için İKİNCİ savunma.
 *
 * Amaç yüksek isabet, DÜŞÜK yanlış pozitif. Eşikler tahminle değil,
 * `test/entropy.test.ts` içindeki pozitif/negatif kümesine göre seçildi;
 * negatif kümesinde bir tane bile bayrak çıkarsa test düşer.
 */

/**
 * Secret olabilecek token şekli.
 *
 * `=` SADECE sonda (base64 dolgusu) kabul edilir. Ortada kabul edersek
 * `DB_PASSWORD=Tk9mQ2vZ...` tek bir token olur: değer anahtar adına yapışır,
 * bağlam kaybolur ve hem kaçırma hem yanlış pozitif üretir — ikisini de
 * ölçtük.
 */
const TOKEN = /[A-Za-z0-9+/_-]{16,}={0,2}/g;

/** Bağlam penceresi: token'ın solundan bu kadar karakter bakılır. */
const CONTEXT_WINDOW = 48;

/** Anahtar benzeri kelime — bağlamlı eşik bununla açılır. */
const KEYISH = /(key|token|secret|password|passwd|pwd|auth|credential|api|bearer|session|cookie|signature)/i;

export const THRESHOLDS = {
  /** Anahtar benzeri bağlam varsa. */
  contextual: { minLength: 16, minEntropy: 3.5 },
  /** Bağlamdan bağımsız — daha uzun ve daha düzensiz olmalı. */
  standalone: { minLength: 32, minEntropy: 4.5 },
} as const;

/** Shannon entropisi (bit/karakter). */
export function shannonEntropy(value: string): number {
  if (value.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / value.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Token'ın solunda anahtar benzeri bir kelime var mı?
 *
 * "hemen solunda" demek: aradaki ayraçlar `=`, `:`, boşluk, tırnak ve süslü
 * parantezden ibaret olmalı. Cümlenin başındaki alakasız bir "api" kelimesi
 * bağlam sayılmaz.
 */
export function hasKeyContext(prefix: string): boolean {
  const window = prefix.slice(-CONTEXT_WINDOW);
  const m = /([A-Za-z_][A-Za-z0-9_.-]*)\s*["']?\s*[=:]?\s*["'({[]?\s*$/.exec(window);
  if (!m) return false;
  const separator = window.slice(m.index + (m[1]?.length ?? 0));
  // Ayraç yoksa (token bir kelimenin devamıysa) bağlam sayma.
  if (separator.trim().length === 0 && !/\s$/.test(window)) return false;
  return KEYISH.test(m[1] ?? "");
}

export interface EntropyHit {
  value: string;
  index: number;
  entropy: number;
  /** Hangi eşikle bayraklandı — bulgu kaydında görünmez, testte işe yarar. */
  via: "contextual" | "standalone";
}

export interface EntropyOptions {
  /** Oda YAML'ındaki `redaction.allow_patterns` — projeye özgü yanlış pozitifler. */
  allowPatterns?: readonly RegExp[];
}

export function scanEntropy(text: string, options: EntropyOptions = {}): EntropyHit[] {
  const hits: EntropyHit[] = [];
  const allow = options.allowPatterns ?? [];

  for (const match of text.matchAll(TOKEN)) {
    const value = match[0];
    const index = match.index ?? 0;
    const prefix = text.slice(Math.max(0, index - CONTEXT_WINDOW), index);

    if (isAllowlisted(value, { prefix })) continue;
    if (allow.some((re) => re.test(value))) continue;

    const entropy = shannonEntropy(value);
    const contextual = hasKeyContext(prefix);

    if (
      contextual &&
      value.length >= THRESHOLDS.contextual.minLength &&
      entropy >= THRESHOLDS.contextual.minEntropy
    ) {
      hits.push({ value, index, entropy, via: "contextual" });
      continue;
    }
    if (
      value.length >= THRESHOLDS.standalone.minLength &&
      entropy >= THRESHOLDS.standalone.minEntropy
    ) {
      hits.push({ value, index, entropy, via: "standalone" });
    }
  }

  return hits;
}
