/**
 * Hafta 7, Adim 3 kabul kriteri — CANLI dogrulama.
 *
 * Iki agentli bir oda acar, izin planini uygular ve container ICINDE
 * `stat` + `id` okuyarak plana uydugunu olcer. Oda sonunda silinir.
 */
import { readFileSync } from "node:fs";

// .env sureç acilisinda okunur (README 6. tuzak); probe da ayni yoldan gecsin.
process.loadEnvFile?.(".env");
import YAML from "yaml";
import { RoomConfig } from "@agent-rooms/protocol";
import {
  closeRoom,
  execCapture,
  openRoom,
  planRoomFs,
  removeRoomVolume,
  verifyFsPlan,
} from "@agent-rooms/core";

const cfg = RoomConfig.parse(YAML.parse(readFileSync("config/room.week7.yaml", "utf8")));
const actor = { kind: "system" };

const result = await openRoom({
  config: cfg,
  configDigest: "week7probe",
  roomsDataDir: "./rooms-data",
  image: "agent-rooms/room:dev",
  actor,
});

const c = result.containerId;
console.log("oda      :", result.room.id);
console.log("volume   :", result.volume);
console.log("uid'ler  :", JSON.stringify(result.uids));

let fail = 0;
const ok = (m) => console.log("  OK   " + m);
const no = (m) => { console.log("  FAIL " + m); fail++; };

// 1) Plan ile gercek birebir mi
const plan = planRoomFs(cfg, result.uids);
const drift = await verifyFsPlan(c, plan);
if (drift.length === 0) ok("stat plana birebir uyuyor (" + plan.dirs.length + " klasor)");
else { no("kayma var:"); for (const d of drift) console.log("       " + d.path + " beklenen=" + d.expected + " gercek=" + d.actual); }

// 2) Ek gruplar yuklu mu
for (const a of cfg.agents) {
  const r = await execCapture({ container: c, user: "root", cmd: ["id", "agent-" + a.name] });
  const out = r.stdout.trim();
  if (out.includes("rooms-contracts")) ok("id agent-" + a.name + " -> " + out);
  else no("agent-" + a.name + " rooms-contracts grubunda degil: " + out);
}

// 3) Integrator hicbir agent grubunda degil
const integ = (await execCapture({ container: c, user: "root", cmd: ["id", "rooms-integrator"] })).stdout.trim();
if (!integ.includes("wtr-") && !integ.includes("rooms-contracts")) ok("id rooms-integrator -> " + integ);
else no("integrator agent gruplarinda: " + integ);

// 4) IZOLASYON: frontend backend'in klasorune giremiyor
const denied = await execCapture({ container: c, user: "agent-frontend", cmd: ["sh", "-c", "ls /room/worktrees/backend"] });
if (denied.exitCode !== 0 && /[Pp]ermission denied/.test(denied.stderr + denied.stdout)) {
  ok("agent-frontend, backend'in klasorunu GOREMIYOR");
} else no("frontend backend'i gordu (kod " + denied.exitCode + "): " + (denied.stdout + denied.stderr).trim());

// 5) Kendi klasorune yazabiliyor
const own = await execCapture({ container: c, user: "agent-frontend", cmd: ["sh", "-c", "touch /room/worktrees/frontend/x && echo yazildi"] });
if (own.stdout.includes("yazildi")) ok("agent-frontend kendi klasorune yazabiliyor");
else no("kendi klasorune yazamadi: " + (own.stdout + own.stderr).trim());

// 6) contracts ortak ve setgid mirasi calisiyor
const wrote = await execCapture({ container: c, user: "agent-frontend", cmd: ["sh", "-c", "umask 002 && echo v1 > /room/contracts/api.md && stat -c '%U %G %a' /room/contracts/api.md"] });
const stat1 = wrote.stdout.trim();
if (stat1.includes("rooms-contracts")) ok("contracts dosyasi grubu miras aldi -> " + stat1);
else no("setgid mirasi yok: " + stat1 + (wrote.stderr || ""));

const append = await execCapture({ container: c, user: "agent-backend", cmd: ["sh", "-c", "echo v2 >> /room/contracts/api.md && cat /room/contracts/api.md"] });
if (append.stdout.includes("v1") && append.stdout.includes("v2")) ok("agent-backend ayni dosyaya ekleyebildi");
else no("backend contracts dosyasina ekleyemedi: " + (append.stdout + append.stderr).trim());

// 7) journal ve merkez depo yazilamaz
for (const [user, path] of [["agent-frontend", "/room/journal/x"], ["agent-frontend", "/room/repo.git/x"]]) {
  const r = await execCapture({ container: c, user, cmd: ["sh", "-c", "touch " + path] });
  if (r.exitCode !== 0) ok(user + " -> " + path + " REDDEDILDI");
  else no(user + " " + path + " yazabildi");
}

// 8) safe.directory sistem duzeyinde yok
const sd = await execCapture({ container: c, user: "root", cmd: ["sh", "-c", "git config --system --get-all safe.directory; echo '[bitti]'"] });
if (sd.stdout.trim() === "[bitti]") ok("sistem duzeyinde safe.directory YOK");
else no("safe.directory tanimli: " + sd.stdout.trim());

console.log("");
console.log(fail === 0 ? "ADIM 3 KABUL: GECTI" : "ADIM 3 KABUL: " + fail + " KONTROL DUSTU");

await closeRoom({ roomId: result.room.id, actor });
await removeRoomVolume(result.room.id);
console.log("temizlendi");
process.exit(fail === 0 ? 0 : 1);
