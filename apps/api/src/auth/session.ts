import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { getPool } from "@agent-rooms/core";
import { hashToken, newToken } from "./tokens.js";
import type { UserRecord } from "./magic-link.js";

/**
 * İnsan oturumu.
 *
 * `auth_sessions` İNSAN oturumudur; `sessions` agent oturumu (Hafta 1).
 * İsimler bilerek ayrı: ikisini karıştırmak tehlikeli bir hata olurdu.
 */

export const SESSION_COOKIE = "rooms_session";
export const SESSION_TTL_DAYS = 30;

export async function createAuthSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
  await getPool().query(
    `INSERT INTO auth_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [userId, hashToken(token), expiresAt],
  );
  return { token, expiresAt };
}

export async function userFromToken(token: string | undefined): Promise<UserRecord | null> {
  if (!token) return null;
  const res = await getPool().query<UserRecord>(
    `SELECT u.id, u.email, u.name
       FROM auth_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  );
  return res.rows[0] ?? null;
}

export async function destroyAuthSession(token: string | undefined): Promise<void> {
  if (!token) return;
  await getPool().query(`DELETE FROM auth_sessions WHERE token_hash = $1`, [hashToken(token)]);
}

export function readSessionCookie(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

export function writeSessionCookie(c: Context, token: string, secure: boolean): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure,
    maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}
