import { getPool } from "@agent-rooms/core";
import { HttpError } from "../http-error.js";
import { hashToken, newToken, tokensMatch } from "./tokens.js";

/**
 * Magic link — şifresiz giriş.
 *
 * TEK KULLANIMLIK ve 15 dakikalık. Davet linkiyle karıştırma: o çok
 * kullanımlıktır (ekibe tek link atılır), bu bir kişinin o anki girişidir.
 */

export const MAGIC_LINK_TTL_MINUTES = 15;
/** E-posta başına 5 dakikada en fazla bu kadar istek. */
export const MAGIC_LINK_RATE_LIMIT = 3;
const RATE_WINDOW_MINUTES = 5;

export interface IssuedLink {
  token: string;
  url: string;
  expiresAt: string;
}

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

export async function issueMagicLink(
  email: string,
  appBaseUrl: string,
  next?: string,
): Promise<IssuedLink> {
  const pool = getPool();
  const addr = normalizeEmail(email);

  const recent = await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM magic_links
      WHERE email = $1 AND created_at > now() - ($2 || ' minutes')::interval`,
    [addr, RATE_WINDOW_MINUTES],
  );
  if (Number(recent.rows[0]?.n ?? 0) >= MAGIC_LINK_RATE_LIMIT) {
    throw new HttpError(429, "çok fazla giriş isteği — birkaç dakika sonra tekrar dene");
  }

  const token = newToken();
  const expires = new Date(Date.now() + MAGIC_LINK_TTL_MINUTES * 60_000);
  await pool.query(
    `INSERT INTO magic_links (token_hash, email, expires_at) VALUES ($1, $2, $3)`,
    [hashToken(token), addr, expires],
  );

  const url = new URL("/auth/callback", appBaseUrl);
  url.searchParams.set("token", token);
  if (next) url.searchParams.set("next", next);

  return { token, url: url.toString(), expiresAt: expires.toISOString() };
}

/**
 * Token'ı harca. Başarılıysa e-posta döner.
 *
 * `used_at` aynı sorguda, koşullu olarak yazılır: iki paralel istek aynı
 * linki kullanamaz (ikincisi 0 satır günceller).
 */
export async function consumeMagicLink(token: string): Promise<string | null> {
  if (!token) return null;
  const pool = getPool();
  const hash = hashToken(token);

  const res = await pool.query<{ email: string; token_hash: string }>(
    `UPDATE magic_links
        SET used_at = now()
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING email, token_hash`,
    [hash],
  );
  const row = res.rows[0];
  if (!row) return null;
  // Aramayı indeks yaptı; okunan hash'i yine de sabit zamanlı doğrula.
  return tokensMatch(row.token_hash, hash) ? row.email : null;
}

export interface UserRecord {
  id: string;
  email: string;
  name: string;
}

/** Kullanıcıyı bul, yoksa yarat. İsim e-postanın `@` öncesi kısmı. */
export async function findOrCreateUser(email: string): Promise<UserRecord> {
  const pool = getPool();
  const addr = normalizeEmail(email);
  const name = addr.split("@")[0] || addr;

  const res = await pool.query<UserRecord>(
    `INSERT INTO users (email, name) VALUES ($1, $2)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id, email, name`,
    [addr, name],
  );
  return res.rows[0]!;
}
