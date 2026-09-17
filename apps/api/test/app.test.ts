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

  it("UUID olmayan oda kimliği DB'ye hiç gitmeden 400", async () => {
    const res = await app.request("/rooms/abc");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: expect.stringContaining("UUID") });
  });

  it("bilinmeyen alan taşıyan gövdeyi reddeder — sessiz yazım hatası olmasın", async () => {
    const res = await app.request("/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spawn_container: false }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues: string[] };
    expect(body.issues.join(" ")).toMatch(/spawn_container/);
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
