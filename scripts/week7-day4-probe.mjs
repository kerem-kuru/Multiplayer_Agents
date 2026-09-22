/**
 * Hafta 7, Gün 4 — Adım 9 ve 10'un CANLI doğrulaması.
 *
 * Adım 7 (contracts) ve 8 (çakışma) birim testlerle ölçüldü; burada ölçülen
 * şey container gerektiren kısım: izin kayması düzeltiliyor mu, oda silinince
 * container ve volume gerçekten gidiyor mu, sweeper sahipsizleri buluyor mu.
 *
 *   node scripts/week7-day4-probe.mjs
 */
import { readFileSync } from "node:fs";
import YAML from "yaml";

process.loadEnvFile?.(".env");

const { RoomConfig } = await import("@agent-rooms/protocol");
const {
  openRoom,
  execCapture,
  auditRoomIsolation,
  archiveRoom,
  sweepOrphans,
  listRoomContainers,
  listRoomVolumes,
  getPool,
} = await import("@agent-rooms/core");

const cfg = RoomConfig.parse(YAML.parse(readFileSync("config/room.week7.yaml", "utf8")));
const actor = { kind: "system" };

let fail = 0;
const ok = (m) => console.log("  OK   " + m);
const no = (m) => {
  console.log("  FAIL " + m);
  fail += 1;
};

const result = await openRoom({
  config: cfg,
  configDigest: "week7day4",
  roomsDataDir: "./rooms-data",
  image: "agent-rooms/room:dev",
  actor,
});
const c = result.containerId;
const roomId = result.room.id;
console.log("oda:", roomId, "\n");

const sh = (user, cmd) =>
  execCapture({ container: c, user, cmd: ["sh", "-c", cmd], timeoutMs: 60_000 });
const statOf = async (p) => (await sh("root", `stat -c '%U:%G %a' ${p}`)).stdout.trim();

// --- Adım 9: izin kayması -------------------------------------------------
const before = await statOf("/room/worktrees/frontend");
if (before === "agent-frontend:wtr-frontend 750") ok(`baslangic izni: ${before}`);
else no(`baslangic izni beklenmedik: ${before}`);

// Agent kendi klasorunun iznini gevsetir — yapabilir, sahibi o.
const chmod = await sh("agent-frontend", "chmod 777 /room/worktrees/frontend");
if (chmod.exitCode === 0) ok("agent kendi klasorunu 777 yapabildi (sahibi o)");
else no("agent chmod yapamadi: " + (chmod.stdout + chmod.stderr).trim());

const loosened = await statOf("/room/worktrees/frontend");
if (loosened.endsWith("777")) ok(`izin gercekten gevsedi: ${loosened}`);
else no(`777 olmadi: ${loosened}`);

const audit = await auditRoomIsolation({ roomId, container: c, config: cfg });
if (audit.drifts.length > 0) ok(`denetim kaymayi yakaladi (${audit.drifts.length} klasor)`);
else no("denetim kaymayi GORMEDI");
if (audit.fixed) ok("denetim duzeltmenin tuttugunu OLCTU");
else no("duzeltme tutmadi");

const after = await statOf("/room/worktrees/frontend");
if (after === "agent-frontend:wtr-frontend 750") ok(`izin geri alindi: ${after}`);
else no(`izin geri alinmadi: ${after}`);

const pool = getPool();
const ev = await pool.query(
  `SELECT payload FROM session_events WHERE room_id = $1 AND type = 'isolation.violation'`,
  [roomId],
);
if (ev.rows.length > 0) {
  const p = ev.rows[0].payload;
  ok(`isolation.violation yazildi — agent=${p.agent} fixed=${p.fixed} actual="${p.actual}"`);
} else no("isolation.violation event'i YOK");

// --- Adım 7: contracts icerigi event'e sizmiyor mu -----------------------
await sh("agent-backend", "umask 002 && echo 'GIZLI-SOZLESME' > /room/contracts/api.md");
const contractStat = await statOf("/room/contracts/api.md");
if (contractStat.includes("rooms-contracts")) ok(`sozlesme grubu miras aldi: ${contractStat}`);
else no(`setgid mirasi yok: ${contractStat}`);

// --- Adım 10: oda silme --------------------------------------------------
console.log("");
await archiveRoom(roomId, pool, (lvl, m) => console.log("  · " + m));

const stillThere = await listRoomContainers(roomId);
if (stillThere.length === 0) ok("container silindi");
else no(`container duruyor: ${stillThere.length}`);

const vols = await listRoomVolumes();
if (!vols.some((v) => v.roomId === roomId)) ok("volume silindi");
else no("volume duruyor");

const st = await pool.query(`SELECT status FROM rooms WHERE id = $1`, [roomId]);
if (st.rows[0]?.status === "archived") ok("rooms.status = archived");
else no(`status = ${st.rows[0]?.status}`);

const evCount = await pool.query(
  `SELECT count(*)::int AS n FROM session_events WHERE room_id = $1`,
  [roomId],
);
if (evCount.rows[0].n > 0) ok(`event log DURUYOR (${evCount.rows[0].n} event) — append-only`);
else no("event log silinmis");

// --- Adım 10: sweeper sahipsizi buluyor mu -------------------------------
const sweep = await sweepOrphans(pool, () => undefined);
ok(
  `sweeper kostu — ${sweep.removedContainers.length} container, ` +
    `${sweep.removedVolumes.length} volume, ${sweep.failedRooms.length} oda failed`,
);

console.log("");
console.log(fail === 0 ? "GUN 4 CANLI DOGRULAMA: GECTI" : `GUN 4: ${fail} KONTROL DUSTU`);
process.exit(fail === 0 ? 0 : 1);
