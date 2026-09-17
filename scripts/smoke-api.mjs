/**
 * Hafta 1 Gün 2-3 "biten iş" kontrolü:
 *   POST /rooms bir container ayağa kaldırıyor, klasör düzeni kuruluyor,
 *   event'ler DB'ye düşüyor, since=N ile geri okunuyor, oda kapanıyor.
 *
 *   npm run build && node scripts/smoke-api.mjs
 *
 * Gerçek docker ve gerçek postgres ister. Saf testler `npm test` içinde.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { closePool, containerStatus, dockerAvailable } from "@agent-rooms/core";
import { createApp } from "../apps/api/dist/app.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.DATABASE_URL ??= "postgres://rooms:Kk2007..@localhost:5433/agent_rooms";

const PORT = Number(process.env.SMOKE_PORT ?? 8788);
const cfg = {
  port: PORT,
  roomsDataDir: path.join(root, "rooms-data"),
  roomImage: process.env.ROOM_IMAGE ?? "agent-rooms/room:dev",
  defaultConfigPath: path.join(root, "config", "room.example.yaml"),
  spawnContainer: true,
};

if (!(await dockerAvailable())) {
  console.error("docker çalışmıyor — Docker Desktop'ı aç");
  process.exit(1);
}

const server = serve({ fetch: createApp(cfg).fetch, port: PORT });
const base = `http://localhost:${PORT}`;
const headers = { "content-type": "application/json", "x-user-id": "u-kerem", "x-user-name": "Kerem" };

const api = async (method, urlPath, body) => {
  const res = await fetch(`${base}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
};

let roomId = null;
let failed = false;

try {
  // 1 — oda aç
  const created = await api("POST", "/rooms", {});
  assert.equal(created.status, 201, `POST /rooms → ${created.status}: ${JSON.stringify(created.json)}`);
  roomId = created.json.room.id;
  assert.ok(created.json.container?.id, "container açılmadı");
  console.log(`oda       ${roomId}`);
  console.log(`container ${created.json.container.name}`);
  console.log(`klasör    ${created.json.layout.dirs.join(", ")}`);
  console.log(`agent     ${created.json.agents.map((a) => a.name).join(", ")}`);

  // 2 — container gerçekten koşuyor mu
  const status = await containerStatus(created.json.container.id);
  assert.equal(status, "running", `container durumu: ${status}`);
  console.log(`durum     ${status}`);

  // 3 — event'ler: room.created + session.started. agent.spawned YOK,
  //     çünkü bu hafta hiçbir agent koşmuyor.
  const all = await api("GET", `/rooms/${roomId}/events`);
  assert.equal(all.status, 200);
  const types = all.json.events.map((e) => `${e.seq}:${e.type}`);
  assert.deepEqual(types, ["1:room.created", "2:session.started"], `event'ler: ${types}`);
  console.log(`event     ${types.join(" ")}`);

  // 4 — since=N: yeniden bağlanan istemcinin boşluk doldurması
  const since = await api("GET", `/rooms/${roomId}/events?since=1`);
  assert.equal(since.json.events.length, 1, "since=1 tek event dönmeli");
  assert.equal(since.json.nextSince, 2, "nextSince istemcinin bir sonraki imleci");
  console.log(`since=1   ${since.json.events.map((e) => `${e.seq}:${e.type}`).join(" ")} (nextSince=${since.json.nextSince})`);

  // 5 — defter iskeleti
  const journal = await api("GET", `/rooms/${roomId}/journal`);
  assert.equal(journal.status, 200);
  assert.equal(journal.json.backend, "filesystem-stub");
  console.log(`defter    ${journal.json.entries.length} kayıt (${journal.json.backend})`);

  // 6 — Cuma dogfood kapısı: izolasyon container içinde tutuyor mu
  const iso = await api("GET", `/rooms/${roomId}/isolation`);
  assert.equal(iso.status, 200);
  for (const c of iso.json.checks) {
    console.log(`izolasyon ${c.agent} (${c.user}): ${c.detail.join(" · ")}`);
  }
  if (iso.json.holds) {
    console.log("izolasyon TUTUYOR ✓");
  } else {
    console.log("izolasyon TUTMUYOR ✗ — ayrıntı için docs/week-01.md");
    failed = true;
  }

  // 7 — odayı kapat
  const stopped = await api("POST", `/rooms/${roomId}/stop`);
  assert.equal(stopped.status, 200);
  assert.equal(stopped.json.event.type, "session.ended");
  const after = await containerStatus(created.json.container.id);
  assert.equal(after, null, `container silinmemiş: ${after}`);
  console.log(`kapandı   ${stopped.json.event.seq}:${stopped.json.event.type}, container silindi`);
} catch (err) {
  console.error(`\nHATA: ${err.message}`);
  failed = true;
} finally {
  server.close();
  await closePool();
}

if (failed) {
  console.error("\nGün 2-3 kapısı geçilemedi.");
  process.exit(1);
}
console.log("\nGün 2-3 kapısı geçildi: POST /rooms container kaldırıyor, event'ler since=N ile okunuyor.");
