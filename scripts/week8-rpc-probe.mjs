/**
 * Hafta 8, Adım 4 — RPC kanalının CANLI doğrulaması.
 *
 * Birim testler (`packages/core/test/week8-rpc.test.ts`) köprüyü ve host'u
 * gerçek DB ile ölçüyor ama `docker exec`'i ve Linux izinlerini ölçemiyor
 * (Windows'ta soket yerine adlandırılmış kanal var). Burada gerçek oda, gerçek
 * runner, gerçek uid'ler:
 *
 * - soket agent'ın HOME'unda, 0600 / dizin 0700, sahibi agent;
 * - agent'ın kendi kullanıcısıyla `journal.write` / `journal.read` gidiş-dönüşü,
 *   kayıt o agent'a yazılıyor;
 * - ÖTEKİ agent'ın kullanıcısı bu sokete bağlanamıyor;
 * - RPC event log'da iz bırakmıyor (yalnızca `journal.entry_written`).
 *
 * Model çağrısı YOK: runner ayağa kalkar, hiçbir mesaj gönderilmez. Gemini
 * anahtarı yalnızca "kimlik doğrulaması var mı" önkoşulu için okunur.
 *
 *   node scripts/week8-rpc-probe.mjs
 */
import { readFileSync } from "node:fs";
import YAML from "yaml";

process.loadEnvFile?.(".env");

const { RoomConfig } = await import("@agent-rooms/protocol");
const { openRoom, execCapture, archiveRoom, AgentManager, getPool, closePool } = await import("@agent-rooms/core");

const cfg = RoomConfig.parse(YAML.parse(readFileSync("config/room.week7.yaml", "utf8")));

let fail = 0;
const ok = (m) => console.log("  OK   " + m);
const no = (m) => {
  console.log("  FAIL " + m);
  fail += 1;
};

const result = await openRoom({
  config: cfg,
  configDigest: "week8rpc",
  roomsDataDir: "./rooms-data",
  image: "agent-rooms/room:dev",
  actor: { kind: "system" },
});
const c = result.containerId;
const roomId = result.room.id;
console.log("oda:", roomId, "\n");

const manager = new AgentManager({
  apiKey: "",
  geminiApiKey: process.env.GEMINI_API_KEY ?? "",
  log: (level, msg) => {
    if (level !== "info") console.log(`  · [${level}] ${msg}`);
  },
});

/** Container içinde, verilen kullanıcıyla tek RPC. Çıktı: cevap JSON'u ya da `ERR <kod>`. */
const CLIENT = `
const net = require("node:net");
const [sock, method, params] = process.argv.slice(1);
const s = net.createConnection(sock);
s.setEncoding("utf8");
let buf = "";
s.on("connect", () => s.write(JSON.stringify({ id: "p1", method, params: JSON.parse(params) }) + "\\n"));
s.on("data", (d) => { buf += d; if (buf.includes("\\n")) { console.log(buf.split("\\n")[0]); s.destroy(); } });
s.on("error", (e) => { console.log("ERR " + e.code); });
`;
const call = async (user, agent, method, params = {}) => {
  const r = await execCapture({
    container: c,
    user,
    cmd: ["node", "-e", CLIENT, `/home/agents/${agent}/.rooms/rpc.sock`, method, JSON.stringify(params)],
    timeoutMs: 30_000,
  });
  return (r.stdout + r.stderr).trim();
};
const sh = async (user, cmd) =>
  (await execCapture({ container: c, user, cmd: ["sh", "-c", cmd], timeoutMs: 30_000 })).stdout.trim();

try {
  for (const a of ["frontend", "backend"]) {
    const st = await manager.start(roomId, a);
    if (st === "idle") ok(`${a} runner ayakta (protokol el sıkışması geçti)`);
    else no(`${a} runner durumu: ${st}`);
  }

  // --- izinler ---------------------------------------------------------------
  const sock = await sh("root", "stat -c '%U %a %F' /home/agents/frontend/.rooms/rpc.sock");
  if (sock === "agent-frontend 600 socket") ok(`soket: ${sock}`);
  else no(`soket beklenmedik: ${sock}`);
  const dir = await sh("root", "stat -c '%U %a' /home/agents/frontend/.rooms");
  if (dir === "agent-frontend 700") ok(`soket dizini: ${dir}`);
  else no(`soket dizini beklenmedik: ${dir}`);

  // --- gidiş-dönüş, agent'ın kendi kullanıcısıyla -----------------------------
  const decision = { what: "JWT yerine session cookie", why: "frontend SSR gerektiriyor", affects: ["frontend"] };
  const w = await call("agent-backend", "backend", "journal.write", {
    agent: "frontend",
    status: "in_progress",
    headline: "Auth endpoint",
    decisions: [decision],
  });
  const wj = w.startsWith("{") ? JSON.parse(w) : null;
  if (wj?.ok && wj.data?.accepted && wj.data.version === 1) ok(`backend yazdı: v${wj.data.version}`);
  else no(`yazım: ${w}`);

  const pool = getPool();
  const rows = await pool.query(`SELECT agent_name FROM journal_entries WHERE room_id = $1`, [roomId]);
  const names = rows.rows.map((r) => r.agent_name).join(",");
  if (names === "backend") ok("kayıt backend'e yazıldı — params'taki agent: frontend yok sayıldı");
  else no(`kayıt sahipleri: ${names || "(yok)"}`);

  const r = await call("agent-frontend", "frontend", "journal.read");
  const rj = r.startsWith("{") ? JSON.parse(r) : null;
  const seen = rj?.data?.decisions?.map((d) => `${d.owner}:${d.what}`) ?? [];
  if (rj?.ok && seen.length === 1 && seen[0] === `backend:${decision.what}`) {
    ok("frontend kendi soketinden okudu: backend'in kararını görüyor");
  } else no(`okuma: ${r}`);

  // --- öteki agent bağlanamaz -------------------------------------------------
  const cross = await call("agent-backend", "frontend", "journal.read");
  if (cross.startsWith("ERR EACCES")) ok(`backend frontend'in soketine bağlanamadı: ${cross}`);
  else no(`çapraz bağlantı: ${cross}`);

  // --- log'da RPC izi yok -----------------------------------------------------
  const ev = await pool.query(
    `SELECT type, count(*)::int AS n FROM session_events WHERE room_id = $1 AND type LIKE 'journal.%' GROUP BY type`,
    [roomId],
  );
  const types = ev.rows.map((x) => `${x.type}×${x.n}`).join(", ");
  if (types === "journal.entry_written×1") ok(`log: ${types} (okumalar ve RPC satırları yok)`);
  else no(`log: ${types || "(boş)"}`);
} finally {
  await manager.shutdownRoom(roomId).catch(() => undefined);
  await archiveRoom(roomId, getPool(), () => undefined).catch((e) => console.log("  · arşiv: " + e));
  await closePool();
}

console.log(fail === 0 ? "\nGEÇTİ" : `\n${fail} KONTROL KALDI`);
process.exit(fail === 0 ? 0 : 1);
