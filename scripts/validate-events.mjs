/**
 * Bir odanın son oturumundaki event log'unun tutarlılığını denetler.
 *
 *   node scripts/validate-events.mjs <roomId>
 *
 * Şemaya uymak yetmez: olayların SIRASI da anlamlı olmalı. Bir tool.result'ın
 * kendinden önce gelen bir tool.call'a bağlanamaması, log'un okunamaz olduğu
 * anlamına gelir — event sourcing'in tüm değeri buradan gelir.
 */
import { RoomEvent } from "@agent-rooms/protocol";
import { closePool, getPool, latestSession, readEvents } from "@agent-rooms/core";

process.env.DATABASE_URL ??= "postgres://rooms:Kk2007..@localhost:5433/agent_rooms";

const roomId = process.argv[2];
if (!roomId) {
  console.error("kullanım: node scripts/validate-events.mjs <roomId>");
  process.exit(1);
}

const problems = [];
const fail = (msg) => problems.push(msg);

const pool = getPool();
const session = await latestSession(roomId, pool);
if (!session) {
  console.error(`odanın oturumu yok: ${roomId}`);
  await closePool();
  process.exit(1);
}

const events = await readEvents(session.id, { limit: 1000 }, pool);
console.log(`oturum ${session.id} · ${events.length} event`);

// 1 — hepsi şemaya uyuyor mu
for (const e of events) {
  const parsed = RoomEvent.safeParse(e);
  if (!parsed.success) {
    fail(`seq ${e.seq} (${e.type}) şemaya uymuyor: ${parsed.error.issues[0]?.message}`);
  }
}

// 2 — seq 1'den başlıyor ve boşluksuz
events.forEach((e, i) => {
  if (e.seq !== i + 1) fail(`seq boşluğu: ${i + 1} beklenirken ${e.seq} geldi`);
});

// 3 — her messageId için turn yaşam döngüsü
const TURN_TYPES = new Set([
  "message.received",
  "turn.started",
  "agent.text",
  "tool.call",
  "tool.result",
  "tool.denied",
  "file.changed",
  "turn.completed",
  "turn.failed",
  "turn.retrying",
]);

const byMessage = new Map();
for (const e of events) {
  if (!TURN_TYPES.has(e.type)) continue;
  const id = e.payload?.messageId;
  if (!id) {
    fail(`seq ${e.seq} (${e.type}) messageId taşımıyor`);
    continue;
  }
  if (!byMessage.has(id)) byMessage.set(id, []);
  byMessage.get(id).push(e);
}

for (const [messageId, list] of byMessage) {
  const types = list.map((e) => e.type);
  const short = messageId.slice(0, 8);

  if (types[0] !== "message.received") {
    fail(`${short}: ilk event message.received değil, ${types[0]}`);
  }
  if (types.length > 1 && types[1] !== "turn.started") {
    fail(`${short}: message.received'ı turn.started izlemiyor, ${types[1]}`);
  }

  const terminal = types.filter((t) => t === "turn.completed" || t === "turn.failed");
  if (terminal.length !== 1) {
    fail(`${short}: tam olarak bir bitiş event'i olmalı, ${terminal.length} tane var`);
  } else if (types[types.length - 1] !== terminal[0]) {
    fail(`${short}: bitiş event'i son sırada değil`);
  }

  // 4 — her tool.result kendinden ÖNCE gelen bir tool.call ile eşleşmeli
  const seen = new Set();
  for (const e of list) {
    if (e.type === "tool.call") seen.add(e.payload.toolUseId);
    if (e.type === "tool.result" && !seen.has(e.payload.toolUseId)) {
      fail(`${short}: tool.result (${e.payload.toolUseId}) eşleşen tool.call'dan önce geldi`);
    }
  }

  // 5 — file.changed bir tool.call'dan sonra gelmeli
  let sawCall = false;
  for (const e of list) {
    if (e.type === "tool.call") sawCall = true;
    if (e.type === "file.changed" && !sawCall) {
      fail(`${short}: file.changed (${e.payload.path}) hiçbir tool.call'dan sonra gelmiyor`);
    }
  }
}

// 6 — heartbeat asla log'a girmemeli
if (events.some((e) => e.type === "heartbeat")) fail("heartbeat event log'a yazılmış");

await closePool();

if (problems.length > 0) {
  console.error(`\n${problems.length} sorun:`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}

console.log(`✓ şema, sıra ve turn yaşam döngüsü tutarlı (${byMessage.size} mesaj)`);
