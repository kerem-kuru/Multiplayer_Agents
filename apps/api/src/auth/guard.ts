import type { Context } from "hono";
import { getPool } from "@agent-rooms/core";
import { HttpError } from "../http-error.js";
import type { UserRecord } from "./magic-link.js";
import { readSessionCookie, userFromToken } from "./session.js";

/**
 * Yetki SUNUCUDA.
 *
 * UI'ın bir düğmeyi gizlemesi yetki değildir; her uç üyeliği ve rolü kendisi
 * kontrol eder. SSE dahil.
 */

export type Role = "owner" | "viewer";

/** Büyük sayı = daha fazla yetki. Hafta 5'te araya yazma rolleri girecek. */
const RANK: Record<Role, number> = { viewer: 1, owner: 2 };

export async function currentUser(c: Context): Promise<UserRecord | null> {
  return userFromToken(readSessionCookie(c));
}

export async function requireUser(c: Context): Promise<UserRecord> {
  const user = await currentUser(c);
  if (!user) throw new HttpError(401, "giriş gerekli");
  return user;
}

export async function roleInRoom(roomId: string, userId: string): Promise<Role | null> {
  const res = await getPool().query<{ role: Role }>(
    `SELECT role FROM room_members WHERE room_id = $1 AND user_id = $2`,
    [roomId, userId],
  );
  return res.rows[0]?.role ?? null;
}

/**
 * Odaya erişim. Var olmayan oda da `403` döner: `404` vermek, hangi oda
 * kimliklerinin var olduğunu sızdırır.
 */
export async function requireRoom(
  c: Context,
  roomId: string,
  minRole: Role = "viewer",
): Promise<{ user: UserRecord; role: Role }> {
  const user = await requireUser(c);
  const role = await roleInRoom(roomId, user.id);
  if (!role || RANK[role] < RANK[minRole]) {
    throw new HttpError(403, "bu odaya erişimin yok");
  }
  return { user, role };
}

export async function addMember(roomId: string, userId: string, role: Role): Promise<void> {
  // Zaten üyeyse rolü DÜŞÜRME: owner'ı davet linkiyle viewer'a çeviremezsin.
  await getPool().query(
    `INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (room_id, user_id) DO NOTHING`,
    [roomId, userId, role],
  );
}
