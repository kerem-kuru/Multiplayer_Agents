/**
 * Gemini koşum ortamı uçtan uca kontrolü — tek gerçek görev.
 *
 *   npm run smoke:gemini
 *
 * Tam kapı DEĞİL, bilerek: Gemini ücretsiz katmanda 503 alıp geri çekiliyor ve
 * turn'ler 11-90 sn sürüyor. 14 kontrollük bir kapı düzensiz düşerdi, düzensiz
 * düşen kapı görmezden gelinir. Burada kanıtlanan tek şey boru hattının ayakta
 * olduğu: görev → gerçek dosya → yapılandırılmış event → temiz kapanış.
 *
 * GEMINI_API_KEY yoksa atlar (hata vermez) — Claude tarafını bloke etmesin.
 */
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { closePool, dockerAvailable, listRoomContainers, stopRoomContainer } from "@agent-rooms/core";
import { createApp } from "../apps/api/dist/app.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.DATABASE_URL ??= "postgres://rooms:Kk2007..@localhost:5433/agent_rooms";

// .env'den anahtarı al (sunucu index.js'i atlıyoruz, app.js doğrudan kuruluyor).
if (!process.env.GEMINI_API_KEY) {
  try {
    const env = await readFile(path.join(root, ".env"), "utf8");
    const line = env.split("\n").find((l) => l.startsWith("GEMINI_API_KEY="));
    if (line) process.env.GEMINI_API_KEY = line.slice("GEMINI_API_KEY=".length).trim();
  } catch {
    // .env yok — aşağıdaki kontrol atlayacak.
  }
}

if (!process.env.GEMINI_API_KEY) {
  console.log("GEMINI_API_KEY yok — Gemini smoke atlandı.");
  process.exit(0);
}
if (!(await dockerAvailable())) {
  console.error("docker çalışmıyor — Docker Desktop'ı aç");
  process.exit(1);
}

const { AgentManager } = await import("@agent-rooms/core");

const PORT = Number(process.env.SMOKE_PORT ?? 8789);
const AGENT = "backend";
const cfg = {
  port: PORT,
  roomsDataDir: path.join(root, "rooms-data"),
  roomImage: process.env.ROOM_IMAGE ?? "agent-rooms/room:dev",
  defaultConfigPath: path.join(root, "config", "room.gemini.yaml"),
  spawnContainer: true,
  agent: {
    apiKey: "",
    geminiApiKey: process.env.GEMINI_API_KEY,
    modelOverride: "",
    maxTurns: 30,
    maxBudgetUsd: 1,
    // Gemini yavaş; heartbeat penceresi geniş tutuluyor.
    heartbeatTimeoutMs: 30_000,
  },
};

const manager = new AgentManager({
  apiKey: "",
  geminiApiKey: cfg.agent.geminiApiKey,
  heartbeatTimeoutMs: cfg.agent.heartbeatTimeoutMs,
  log: (level, msg) => {
    if (level !== "info") console.error(`  [${level}] ${msg}`);
  },
});
manager.startHealthChecks();

const server = serve({ fetch: createApp(cfg, manager).fetch, port: PORT });
const base = `http://localhost:${PORT}`;
const headers = { "content-type": "application/json", "x-user-id": "smoke" };

const api = async (method, urlPath, body) => {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
};

const statusOf = async (roomId) => {
  const { json } = await api("GET", `/rooms/${roomId}/agents`);
  return json.agents.find((a) => a.name === AGENT)?.runtime?.status ?? "?";
};

let roomId = null;
let failed = false;

try {
  const created = await api("POST", "/rooms", {});
  assert.equal(created.status, 201, `POST /rooms → ${created.status}`);
  roomId = created.room?.id ?? created.json.room.id;
  console.log(`oda       ${roomId}`);
  console.log(`runtime   ${created.json.agents.map((a) => a.name).join(", ")} (gemini)`);

  const msg = await api("POST", `/rooms/${roomId}/agents/${AGENT}/message`, {
    text: "Bulundugun klasorde hello.js adinda, konsola merhaba oda yazdiran bir dosya olustur.",
  });
  assert.equal(msg.status, 202, `mesaj → ${msg.status}: ${JSON.stringify(msg.json)}`);
  const messageId = msg.json.messageId;
  console.log(`görev     ${messageId}`);

  // Gemini yavaş: 5 dakikaya kadar bekle.
  const deadline = Date.now() + 300_000;
  let status = "";
  while (Date.now() < deadline) {
    status = await statusOf(roomId);
    if (status === "idle") break;
    if (status === "failed") break;
    await new Promise((r) => setTimeout(r, 4000));
  }
  assert.equal(status, "idle", `agent idle'a dönmedi, durum: ${status}`);
  console.log(`durum     ${status}`);

  const { json: ev } = await api("GET", `/rooms/${roomId}/events?since=0&limit=200`);
  const mine = ev.events.filter((e) => e.payload?.messageId === messageId);
  const types = new Set(mine.map((e) => e.type));
  for (const need of [
    "message.received",
    "turn.started",
    "tool.call",
    "file.changed",
    "tool.result",
    "turn.completed",
  ]) {
    assert.ok(types.has(need), `eksik event: ${need} (gelenler: ${[...types].join(",")})`);
  }
  console.log(`event     ${mine.map((e) => e.type).join(" → ")}`);

  const changed = mine.find((e) => e.type === "file.changed");
  assert.ok(
    !changed.payload.path.startsWith("/"),
    `file.changed yolu oda-göreli olmalı: ${changed.payload.path}`,
  );

  const hello = path.join(cfg.roomsDataDir, roomId, "worktrees", AGENT, "hello.js");
  const content = await readFile(hello, "utf8");
  assert.match(content, /merhaba oda/, `hello.js beklenen metni içermiyor: ${content}`);
  console.log(`dosya     hello.js gerçekten var ve doğru`);

  await api("POST", `/rooms/${roomId}/agents/${AGENT}/stop`);
  await new Promise((r) => setTimeout(r, 3000));
  console.log(`kapandı   ${await statusOf(roomId)}`);
} catch (err) {
  console.error(`\nHATA: ${err.message}`);
  failed = true;
} finally {
  await manager.shutdownAll().catch(() => undefined);
  server.close();
  // Bu smoke'un açtığı container'ı bırakma.
  if (roomId) {
    for (const c of await listRoomContainers(roomId).catch(() => [])) {
      await stopRoomContainer(c.Id).catch(() => undefined);
    }
    await rm(path.join(cfg.roomsDataDir, roomId), { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
  await closePool();
}

if (failed) {
  console.error("\nGemini boru hattı BOZUK.");
  process.exit(1);
}
console.log("\nGemini boru hattı ayakta: görev → gerçek dosya → yapılandırılmış event.");
