/**
 * Hafta 1 "biten iş" kontrolü:
 *   oda kaydı DB'de duruyor → elle event yazılıyor → since=N ile geri okunuyor.
 *
 *   npm run build && node scripts/smoke.mjs
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendEvent,
  closePool,
  createRoom,
  createSession,
  getPool,
  loadRoomConfig,
  readEvents,
  scaffoldRoomLayout,
  mountPlan,
} from "@agent-rooms/core";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.env.DATABASE_URL ??= "postgres://rooms:Kk2007..@localhost:5433/agent_rooms";

const { config, digest } = await loadRoomConfig(path.join(root, "config", "room.example.yaml"));
console.log(`config  ${config.agents.length} agent: ${config.agents.map((a) => a.name).join(", ")}`);

const pool = getPool();
const room = await createRoom(config, digest, pool);
console.log(`oda     ${room.id}`);

const session = await createSession(room.id, pool);
console.log(`oturum  ${session.id}`);

const roomRoot = path.join(root, "rooms-data", room.id);
const dirs = await scaffoldRoomLayout(roomRoot, config);
console.log(`klasör  ${dirs.length} dizin: ${dirs.map((d) => path.relative(roomRoot, d)).join(", ")}`);

const actor = { kind: "system" };
const base = { roomId: room.id, sessionId: session.id, actor };

await appendEvent(
  { ...base, type: "room.created", payload: { name: config.name, repoUrl: config.repoUrl, configDigest: digest } },
  pool,
);
await appendEvent(
  { ...base, type: "session.started", payload: { containerId: "dev-local", agents: config.agents.map((a) => a.name) } },
  pool,
);
for (const agent of config.agents) {
  await appendEvent(
    { ...base, type: "agent.starting", payload: { agent: agent.name, resumeSessionId: null } },
    pool,
  );
}

const all = await readEvents(session.id, {}, pool);
console.log(`event   ${all.length} kayıt: ${all.map((e) => `${e.seq}:${e.type}`).join(" ")}`);

const since = await readEvents(session.id, { since: 2 }, pool);
console.log(`since=2 ${since.length} kayıt: ${since.map((e) => `${e.seq}:${e.type}`).join(" ")}`);

for (const plan of mountPlan(config)) {
  console.log(`mount   ${plan.agent}: rw=${plan.readWrite.join(",")} ro=${plan.readOnly.join(",")}`);
}

// Append-only gerçekten zorlanıyor mu?
try {
  await pool.query("UPDATE session_events SET type = 'hacked' WHERE session_id = $1", [session.id]);
  console.error("HATA: append-only trigger çalışmadı");
  process.exitCode = 1;
} catch {
  console.log("append  UPDATE engellendi ✓");
}

await closePool();
console.log("\nHafta 1 omurgası ayakta.");
