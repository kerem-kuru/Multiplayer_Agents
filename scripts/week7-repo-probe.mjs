/**
 * Hafta 7, Adım 4 kabul kriteri — CANLI doğrulama.
 *
 * İki agentlı bir oda açar ve merkez depo + agent klonlarını container İÇİNDE
 * ölçer. Oda sonunda silinir.
 *
 *   node scripts/week7-repo-probe.mjs
 */
import { readFileSync } from "node:fs";
import YAML from "yaml";

process.loadEnvFile?.(".env");

const { RoomConfig } = await import("@agent-rooms/protocol");
const { openRoom, closeRoom, execCapture, removeRoomVolume, CENTRAL_REPO } = await import(
  "@agent-rooms/core"
);

const cfg = RoomConfig.parse(YAML.parse(readFileSync("config/room.week7.yaml", "utf8")));
const actor = { kind: "system" };

const result = await openRoom({
  config: cfg,
  configDigest: "week7repoprobe",
  roomsDataDir: "./rooms-data",
  image: "agent-rooms/room:dev",
  actor,
});

const c = result.containerId;
const short = result.room.id.replace(/-/g, "").slice(0, 8);

let fail = 0;
const ok = (m) => console.log("  OK   " + m);
const no = (m) => {
  console.log("  FAIL " + m);
  fail++;
};

/** Container içinde kabuk komutu. */
const sh = async (user, cmd) =>
  execCapture({ container: c, user, cmd: ["sh", "-c", cmd], timeoutMs: 120_000 });
const out = async (user, cmd) => (await sh(user, cmd)).stdout.trim();

const repoEvent = result.events.find((e) => e.type === "room.repo_initialized");
const readyEvents = result.events.filter((e) => e.type === "agent.workspace_ready");
const baseSha = repoEvent?.payload?.baseSha ?? "";

console.log("oda     :", result.room.id);
console.log("taban   :", baseSha, "(" + repoEvent?.payload?.source + ")");
console.log("");

// --- 1) event'ler ----------------------------------------------------------
if (repoEvent) ok("room.repo_initialized yazıldı");
else no("room.repo_initialized yok");
if (readyEvents.length === cfg.agents.length) {
  ok(`agent.workspace_ready x${readyEvents.length}`);
} else no(`agent.workspace_ready sayısı ${readyEvents.length}, beklenen ${cfg.agents.length}`);

// --- 2) her klonun branch'i ve HEAD'i --------------------------------------
for (const a of cfg.agents) {
  const dir = `/room/worktrees/${a.name}`;
  const user = `agent-${a.name}`;
  const branch = await out(user, `git -C ${dir} branch --show-current`);
  const head = await out(user, `git -C ${dir} rev-parse HEAD`);
  const beklenen = `room-${short}/${a.name}`;

  if (branch === beklenen) ok(`${a.name} branch = ${branch}`);
  else no(`${a.name} branch = "${branch}", beklenen "${beklenen}"`);

  if (head === baseSha) ok(`${a.name} HEAD = base_sha`);
  else no(`${a.name} HEAD = ${head}, base_sha = ${baseSha}`);

  // alternates: nesneler merkezden ödünç alınıyor mu
  const alt = await out(user, `cat ${dir}/.git/objects/info/alternates`);
  if (alt.includes("/room/repo.git")) ok(`${a.name} alternates -> ${alt}`);
  else no(`${a.name} alternates merkezi göstermiyor: "${alt}"`);
}

// --- 3) merkez depo sahipliği ve sertleştirme ------------------------------
const repoOwner = await out("root", `stat -c '%U %G %a' ${CENTRAL_REPO}`);
if (repoOwner.startsWith("rooms-integrator rooms-integrator"))
  ok(`merkez depo sahibi: ${repoOwner}`);
else no(`merkez depo sahibi yanlış: ${repoOwner}`);

const beklenenCfg = {
  "gc.auto": "0",
  "gc.pruneExpire": "never",
  "gc.reflogExpire": "never",
  "receive.denyDeletes": "true",
  "receive.denyNonFastForwards": "true",
  "core.logAllRefUpdates": "always",
};
for (const [k, v] of Object.entries(beklenenCfg)) {
  const got = await out("rooms-integrator", `git -C ${CENTRAL_REPO} config --get ${k}`);
  if (got === v) ok(`${k} = ${v}`);
  else no(`${k} = "${got}", beklenen "${v}"`);
}

const baseRef = await out("rooms-integrator", `git -C ${CENTRAL_REPO} rev-parse refs/rooms/base/${short}`);
if (baseRef === baseSha) ok(`refs/rooms/base/${short} korumalı ref taban commit'i gösteriyor`);
else no(`refs/rooms/base/${short} = "${baseRef}", beklenen ${baseSha}`);

// --- 4) G4: gc sonrası klonlar sağlam --------------------------------------
const gc = await sh("rooms-integrator", `git -C ${CENTRAL_REPO} gc 2>&1 | tail -2; echo "kod=$?"`);
if (gc.exitCode === 0) ok("merkezde gc koştu");
else no("gc düştü: " + gc.stdout + gc.stderr);

for (const a of cfg.agents) {
  const dir = `/room/worktrees/${a.name}`;
  const user = `agent-${a.name}`;
  const fsck = await sh(user, `git -C ${dir} fsck --connectivity-only && git -C ${dir} log -1 --format=%H`);
  if (fsck.exitCode === 0 && fsck.stdout.trim().endsWith(baseSha)) {
    ok(`${a.name} klonu gc sonrası SAĞLAM (fsck + log -1)`);
  } else no(`${a.name} klonu gc sonrası bozuk: ${(fsck.stdout + fsck.stderr).trim().slice(0, 200)}`);
}

// --- 5) G1: başkasının branch'ini silemez ----------------------------------
const delRef = await sh("agent-frontend", `git -C ${CENTRAL_REPO} update-ref -d refs/heads/main`);
if (delRef.exitCode !== 0) ok("agent-frontend merkezdeki main'i SİLEMEDİ");
else no("agent-frontend merkezdeki main'i sildi");

const delBranch = await sh("agent-frontend", `git -C /room/worktrees/backend branch -D room-${short}/backend`);
if (delBranch.exitCode !== 0) ok("agent-frontend backend'in branch'ini SİLEMEDİ");
else no("agent-frontend backend'in branch'ini sildi");

const push = await sh("agent-frontend", `git -C /room/worktrees/frontend push origin HEAD:refs/heads/kotu`);
if (push.exitCode !== 0) ok("agent-frontend merkeze PUSH EDEMEDİ");
else no("agent-frontend merkeze push etti");

// --- 6) G3: başkasının .git'ine yazamaz ------------------------------------
for (const path of ["/room/worktrees/backend/.git/config", "/room/worktrees/backend/.git/objects/kotu"]) {
  const r = await sh("agent-frontend", `echo x > ${path}`);
  if (r.exitCode !== 0) ok(`agent-frontend -> ${path} REDDEDİLDİ`);
  else no(`agent-frontend ${path} dosyasına yazabildi`);
}

// --- 7) G7: root bile agent deposunu açamaz (sahiplik kontrolü açık) -------
const rootGit = await sh("root", `git -C /room/worktrees/frontend status`);
if (rootGit.exitCode !== 0 && /dubious ownership|detected dubious/i.test(rootGit.stdout + rootGit.stderr)) {
  ok("root agent deposunda 'dubious ownership' aldı — sahiplik kontrolü AÇIK");
} else {
  no(`root agent deposunu açtı (kod ${rootGit.exitCode}): ${(rootGit.stdout + rootGit.stderr).trim().slice(0, 160)}`);
}

console.log("");
console.log(fail === 0 ? "ADIM 4 KABUL: GEÇTİ" : `ADIM 4 KABUL: ${fail} KONTROL DÜŞTÜ`);

await closeRoom({ roomId: result.room.id, actor });
await removeRoomVolume(result.room.id);
console.log("temizlendi");
process.exit(fail === 0 ? 0 : 1);
