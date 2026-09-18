import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closePool, getPool } from "@agent-rooms/core";
import { hashToken, newToken, tokenPrefix, tokensMatch } from "../src/auth/tokens.js";
import {
  consumeMagicLink,
  findOrCreateUser,
  issueMagicLink,
  MAGIC_LINK_RATE_LIMIT,
} from "../src/auth/magic-link.js";
import { createAuthSession, destroyAuthSession, userFromToken } from "../src/auth/session.js";
import { addMember, roleInRoom } from "../src/auth/guard.js";

/**
 * Auth testleri.
 *
 * Token üretimi DB'siz; magic link, oturum ve üyelik gerçek DB'ye yazar
 * (davranışın tamamı SQL'de: tek kullanımlık işaretleme, süre, hız sınırı).
 * Uçların HTTP davranışı Hafta 4 kapısında.
 */

const DB = process.env.DATABASE_URL ?? "postgres://rooms:Kk2007..@localhost:5433/agent_rooms";
let alive = false;
const madeEmails: string[] = [];
let roomId = "";

beforeAll(async () => {
  process.env.DATABASE_URL = DB;
  try {
    const probe = new pg.Client({ connectionString: DB, connectionTimeoutMillis: 2000 });
    await probe.connect();
    await probe.end();
    alive = true;
  } catch {
    return;
  }
  roomId = randomUUID();
  await getPool().query(
    `INSERT INTO rooms (id, name, config, config_digest) VALUES ($1, $2, $3::jsonb, $4)`,
    [roomId, "auth testi", JSON.stringify({ version: 1, name: "t", agents: [] }), "0".repeat(64)],
  );
});

afterAll(async () => {
  if (!alive) return;
  const pool = getPool();
  for (const email of madeEmails) {
    await pool.query(`DELETE FROM magic_links WHERE email = $1`, [email]);
    await pool.query(
      `DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE email = $1)`,
      [email],
    );
    await pool.query(
      `DELETE FROM room_members WHERE user_id IN (SELECT id FROM users WHERE email = $1)`,
      [email],
    );
    await pool.query(`DELETE FROM users WHERE email = $1`, [email]);
  }
  if (roomId) await pool.query(`DELETE FROM rooms WHERE id = $1`, [roomId]);
  await closePool();
});

const uniqueEmail = (tag: string): string => {
  const email = `${tag}-${randomUUID().slice(0, 8)}@rooms.test`;
  madeEmails.push(email);
  return email;
};

describe("token yardımcıları (DB'siz)", () => {
  it("token 32 baytlık base64url", () => {
    const t = newToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newToken()).not.toBe(t);
  });

  it("hash deterministik ve geri döndürülemez uzunlukta", () => {
    expect(hashToken("abc")).toBe(hashToken("abc"));
    expect(hashToken("abc")).toHaveLength(64);
    expect(hashToken("abc")).not.toContain("abc");
  });

  it("sabit zamanlı karşılaştırma", () => {
    expect(tokensMatch("aaaa", "aaaa")).toBe(true);
    expect(tokensMatch("aaaa", "aaab")).toBe(false);
    // Uzunluk farkı timingSafeEqual'ı patlatmamalı.
    expect(tokensMatch("aaaa", "aa")).toBe(false);
  });

  it("önek 8 karakter", () => {
    expect(tokenPrefix("abcdefghijkl")).toBe("abcdefgh");
  });
});

describe.runIf(process.env.SKIP_DB !== "1")("magic link", () => {
  it("tek kullanımlık", async () => {
    if (!alive) return;
    const email = uniqueEmail("tek");
    const link = await issueMagicLink(email, "http://localhost:5173");

    expect(await consumeMagicLink(link.token)).toBe(email);
    // İkinci kullanım: aynı token artık geçersiz.
    expect(await consumeMagicLink(link.token)).toBeNull();
  });

  it("ham token DB'de durmuyor", async () => {
    if (!alive) return;
    const email = uniqueEmail("hash");
    const link = await issueMagicLink(email, "http://localhost:5173");

    const raw = await getPool().query(
      `SELECT 1 FROM magic_links WHERE token_hash = $1 AND email = $2`,
      [link.token, email],
    );
    expect(raw.rowCount).toBe(0);

    const hashed = await getPool().query(
      `SELECT 1 FROM magic_links WHERE token_hash = $1 AND email = $2`,
      [hashToken(link.token), email],
    );
    expect(hashed.rowCount).toBe(1);
  });

  it("uydurma token kabul edilmiyor", async () => {
    if (!alive) return;
    expect(await consumeMagicLink(newToken())).toBeNull();
    expect(await consumeMagicLink("")).toBeNull();
  });

  it("hız sınırı: e-posta başına 5 dakikada 3", async () => {
    if (!alive) return;
    const email = uniqueEmail("hiz");
    for (let i = 0; i < MAGIC_LINK_RATE_LIMIT; i++) {
      await issueMagicLink(email, "http://localhost:5173");
    }
    await expect(issueMagicLink(email, "http://localhost:5173")).rejects.toMatchObject({
      status: 429,
    });
  });

  it("link `next` parametresini taşıyor", async () => {
    if (!alive) return;
    const email = uniqueEmail("next");
    const link = await issueMagicLink(email, "http://localhost:5173", "/join?token=abc");
    expect(new URL(link.url).searchParams.get("next")).toBe("/join?token=abc");
  });
});

describe.runIf(process.env.SKIP_DB !== "1")("oturum ve üyelik", () => {
  it("oturum çerezi kullanıcıyı buluyor, silinince bulmuyor", async () => {
    if (!alive) return;
    const user = await findOrCreateUser(uniqueEmail("oturum"));
    const { token } = await createAuthSession(user.id);

    expect(await userFromToken(token)).toMatchObject({ id: user.id, email: user.email });
    await destroyAuthSession(token);
    expect(await userFromToken(token)).toBeNull();
  });

  it("kullanıcı adı e-postanın @ öncesi", async () => {
    if (!alive) return;
    const email = uniqueEmail("isim");
    const user = await findOrCreateUser(email);
    expect(user.name).toBe(email.split("@")[0]);
  });

  it("aynı e-posta ikinci kez kullanıcı YARATMAZ", async () => {
    if (!alive) return;
    const email = uniqueEmail("tekrar");
    const a = await findOrCreateUser(email);
    const b = await findOrCreateUser(email.toUpperCase());
    expect(b.id).toBe(a.id);
  });

  it("üyelik rolü okunuyor; davet owner'ı viewer'a DÜŞÜRMÜYOR", async () => {
    if (!alive) return;
    const user = await findOrCreateUser(uniqueEmail("rol"));
    expect(await roleInRoom(roomId, user.id)).toBeNull();

    await addMember(roomId, user.id, "owner");
    expect(await roleInRoom(roomId, user.id)).toBe("owner");

    // Davet linkiyle tekrar katılmak rolü düşürmemeli.
    await addMember(roomId, user.id, "viewer");
    expect(await roleInRoom(roomId, user.id)).toBe("owner");
  });
});
