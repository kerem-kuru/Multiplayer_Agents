import path from "node:path";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { ApiConfig } from "../src/config.js";
import { HttpError } from "../src/http-error.js";
import { requireUtf8Body } from "../src/utf8-body.js";

/** app.test.ts ile aynı: DB'siz, ortamdan bağımsız. */
delete process.env.DATABASE_URL;

const bytes = (...parts: (string | number[])[]) =>
  Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p, "utf8") : Buffer.from(p))));

/**
 * 13 Ekim'de ölçülen gerçek bozulma: Git'in curl'ü `-d` argümanını cp1254
 * gönderiyor — "oluştur ı" → `olu\xFEtur \xFD`. API bunu 201 ile "olu�tur �"
 * diye kaydediyordu.
 */
const CP1254 = bytes('{"text":"olu', [0xfe], "tur ", [0xfd], '"}');
/** Yarıda kalmış iki baytlık dizi: `ş` = C5 9F, ikinci bayt yok. */
const TRUNCATED = bytes('{"text":"', [0xc5], '"}');
/** UTF-8 ile kodlanmış surrogate (U+D800) — WTF-8, geçerli UTF-8 değil. */
const SURROGATE = bytes('{"text":"', [0xed, 0xa0, 0x80], '"}');
const TURKISH = "oluştur ı ş ğ ç ö ü İ";

function echoApp() {
  const app = new Hono();
  app.use("*", requireUtf8Body);
  app.post("/echo", async (c) => c.json(await c.req.json()));
  app.get("/ping", (c) => c.text("pong"));
  app.onError((err, c) =>
    err instanceof HttpError ? c.json({ error: err.message }, err.status) : c.json({ error: String(err) }, 500),
  );
  return app;
}

const post = (app: { request: Hono["request"] }, url: string, body: BodyInit, contentType = "application/json") =>
  app.request(url, { method: "POST", headers: { "content-type": contentType }, body });

describe("requireUtf8Body — geçersiz UTF-8 ikame edilmez, 400", () => {
  const app = echoApp();

  for (const [name, body] of [
    ["cp1254 (curl -d'nin gerçek baytları)", CP1254],
    ["yarıda kalmış çok baytlı dizi", TRUNCATED],
    ["kodlanmış surrogate", SURROGATE],
  ] as const) {
    it(name, async () => {
      const res = await post(app, "/echo", body);
      expect(res.status).toBe(400);
      await expect(res.json()).resolves.toEqual({ error: "gövde geçerli UTF-8 değil" });
    });
  }

  it("geçerli Türkçe uca BİREBİR ulaşır — geçit gövdeyi tüketmez, yeniden kodlamaz", async () => {
    const res = await post(app, "/echo", Buffer.from(JSON.stringify({ text: TURKISH }), "utf8"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ text: TURKISH });
  });

  it("charset UTF-8 dışındaysa 400", async () => {
    const res = await post(app, "/echo", JSON.stringify({ text: "a" }), "application/json; charset=windows-1254");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "gövde kodlaması UTF-8 olmalı (charset=windows-1254)" });
  });

  it.each(["application/json; charset=UTF-8", 'application/json; charset="utf-8"', "application/json;charset=utf8"])(
    "charset UTF-8 yazımları kabul: %s",
    async (ct) => {
      const res = await post(app, "/echo", JSON.stringify({ text: TURKISH }), ct);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ text: TURKISH });
    },
  );

  it("GET'e dokunmaz", async () => {
    const res = await app.request("/ping");
    expect(res.status).toBe(200);
  });
});

describe("requireUtf8Body — API'ye bağlı", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const cfg: ApiConfig = {
    port: 0,
    roomsDataDir: path.join(repoRoot, "rooms-data"),
    roomImage: "agent-rooms/room:dev",
    defaultConfigPath: path.join(repoRoot, "config", "room.example.yaml"),
    spawnContainer: false,
  };
  const app = createApp(cfg);

  it("giriş ucu bozuk gövdeyi 400 ile reddeder", async () => {
    const res = await post(app, "/auth/request", CP1254);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "gövde geçerli UTF-8 değil" });
  });

  /**
   * BİLİNÇLİ İSTİSNA (utf8-body.ts): geçit kimlikten önce çalışır. Kimliksiz
   * ve bozuk gövdeli oda açma 401 değil 400 alır. Geçerli gövdeyle aynı istek
   * hâlâ 401 (app.test.ts "kimliksiz oda açma ...").
   */
  it("kimliksiz + bozuk gövde: 400 (kimlik sırası istisnası)", async () => {
    const res = await post(app, "/rooms", CP1254);
    expect(res.status).toBe(400);
  });
});
