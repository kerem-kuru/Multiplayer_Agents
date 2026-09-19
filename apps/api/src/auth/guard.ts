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

export type Role = "owner" | "member" | "viewer";
export const ROLES: readonly Role[] = ["owner", "member", "viewer"];

/**
 * Büyük sayı = daha fazla yetki.
 *
 * `member` Hafta 5'te geldi: kuyruğa mesaj ekler, kendi kaydını iptal eder,
 * sürücülüğü alır/devreder, sürücüyken keser. Oda ayarları, davet üretme ve
 * agent start/stop yalnızca `owner`.
 *
 * Sürücülük bu sıralamada YOK — o bir rol değil, agent başına bir görev
 * (bkz. `agent_driver`). Sürücü olmayan `member` odayı kullanmaya devam eder.
 */
const RANK: Record<Role, number> = { viewer: 1, member: 2, owner: 3 };

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

/**
 * Davet kabulü / oda açılışı. Rol ASLA DÜŞMEZ, yükselebilir.
 *
 * Hafta 4'te `DO NOTHING` vardı: owner'ı davet linkiyle viewer'a çevirmek
 * engelleniyordu ama `viewer` olarak girmiş biri `member` davetini kabul
 * edince de hiçbir şey olmuyordu — linke tıklıyor, ekran değişmiyordu.
 * Rolü düşürmek yalnızca oda sahibinin işi (`setMemberRole`).
 */
export async function addMember(roomId: string, userId: string, role: Role): Promise<void> {
  await getPool().query(
    `INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (room_id, user_id) DO UPDATE
        SET role = CASE
          WHEN room_members.role = 'owner' THEN 'owner'
          WHEN room_members.role = 'member' AND EXCLUDED.role = 'viewer' THEN 'member'
          ELSE EXCLUDED.role
        END`,
    [roomId, userId, role],
  );
}

export interface RoomMember {
  userId: string;
  name: string;
  email: string;
  role: Role;
  joinedAt: string;
}

/**
 * Odanın üyeleri. Sürücü devri bunu kullanıyor: "Devret → kişi seç" iki tık
 * olacaksa istemcinin kime devredebileceğini bir istekte görmesi gerekir.
 */
export async function listMembers(roomId: string): Promise<RoomMember[]> {
  const res = await getPool().query<{
    user_id: string;
    name: string;
    email: string;
    role: Role;
    joined_at: Date;
  }>(
    `SELECT m.user_id, u.name, u.email, m.role, m.joined_at
       FROM room_members m JOIN users u ON u.id = m.user_id
      WHERE m.room_id = $1
      ORDER BY m.joined_at`,
    [roomId],
  );
  return res.rows.map((r) => ({
    userId: r.user_id,
    name: r.name,
    email: r.email,
    role: r.role,
    joinedAt: r.joined_at.toISOString(),
  }));
}

/** Oda sahibi rolü değiştirir. Son owner'ı düşürmek YASAK — oda sahipsiz kalmaz. */
export async function setMemberRole(
  roomId: string,
  userId: string,
  role: Role,
): Promise<{ changed: boolean; reason?: "not_member" | "last_owner" }> {
  const pool = getPool();
  const cur = await pool.query<{ role: Role }>(
    `SELECT role FROM room_members WHERE room_id = $1 AND user_id = $2`,
    [roomId, userId],
  );
  const existing = cur.rows[0]?.role;
  if (!existing) return { changed: false, reason: "not_member" };
  if (existing === role) return { changed: true };

  if (existing === "owner") {
    const owners = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM room_members WHERE room_id = $1 AND role = 'owner'`,
      [roomId],
    );
    if (Number(owners.rows[0]?.n ?? "0") <= 1) return { changed: false, reason: "last_owner" };
  }

  await pool.query(`UPDATE room_members SET role = $3 WHERE room_id = $1 AND user_id = $2`, [
    roomId,
    userId,
    role,
  ]);
  return { changed: true };
}
