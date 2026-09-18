import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { resolveConfigPath, type ApiConfig } from "../src/config.js";

/**
 * DB gerektirmeyen uçlar ve doğrulama yolları. Gerçek oda açma
 * `scripts/smoke-api.mjs` içinde, docker + postgres ile koşuyor.
 */

/**
 * Bu dosya DB'SİZ koşar. Ortamda DATABASE_URL varsa (kapı script'i onu
 * export ediyor) /health 200 dönerdi ve test ortama göre değişirdi —
 * testler ortamdan bağımsız olmalı.
 */
delete process.env.DATABASE_URL;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const cfg: ApiConfig = {
  port: 0,
  roomsDataDir: path.join(repoRoot, "rooms-data"),
  roomImage: "agent-rooms/room:dev",
  defaultConfigPath: path.join(repoRoot, "config", "room.example.yaml"),
  spawnContainer: false,
};

const app = createApp(cfg);

describe("api", () => {
  it("/health DB'ye dokunur — DB yoksa ok:false ve 503", async () => {
    // Bu testte DATABASE_URL yok; sağlık ucu bunu yutmamalı.
    const res = await app.request("/health");
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ ok: false, db: false });
  });

  it("üretimde elle event yazma ucu tanımlı değil", async () => {
    // Bu süreçte NODE_ENV=test, yani uç kayıtlı; UUID olmayan id 400 vermeli.
    const res = await app.request("/sessions/abc/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "debug.note", payload: { text: "x" } }),
    });
    expect(res.status).toBe(400);
  });

  it("bilinmeyen uç 404", async () => {
    expect((await app.request("/yok")).status).toBe(404);
  });

  /**
   * Hafta 4'ten itibaren SIRA: önce kimlik, sonra doğrulama.
   *
   * Kimliksiz bir istek gövde doğrulamasına HİÇ ulaşmamalı — hangi alanın
   * kabul edildiği, hangi oda kimliğinin geçerli olduğu bilgisi de yetki
   * ister. Bu iki test o sırayı kilitliyor.
   */
  it("kimliksiz istek UUID doğrulamasına bile ulaşmadan 401", async () => {
    const res = await app.request("/rooms/abc");
    expect(res.status).toBe(401);
  });

  it("kimliksiz oda açma gövde doğrulamasına ulaşmadan 401", async () => {
    const res = await app.request("/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spawn_container: false }),
    });
    expect(res.status).toBe(401);
  });

  it("giriş uçları oturum istemez — 401 döngüsüne girmesin", async () => {
    // Geçersiz e-posta: uç çalıştı demektir (401 değil, 400).
    const res = await app.request("/auth/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "eposta-degil" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("konfigürasyon yolu", () => {
  it("varsayılan örnek YAML'a düşer", () => {
    expect(resolveConfigPath(cfg)).toBe(cfg.defaultConfigPath);
  });

  it("repo kökünün dışına çıkmayı reddeder", () => {
    expect(() => resolveConfigPath(cfg, "../../etc/passwd")).toThrow(/dışında/);
  });
});
