/**
 * Gun 3 olcumu: sunucunun docker exec yolu GERCEKTEN calisiyor mu.
 *
 * Bu script bir oda container'i taklit eder (ayni imaj, ayni bind mount) ve
 * core/src/diff.ts'teki yollari kullanir. Hicbir modele istek gitmez.
 *
 * DIKKAT — olcumun kendisi olcuyu bozabilir: dogrulama icin calistirilan
 * `git status` de ekilmis fsmonitor komutunu TETIKLER. O zaman /tmp/pwned
 * olusur ve kapi "gitkit tetikledi" diye yanlis rapor verir. Bu yuzden
 * dogrulama git'i de KORUMALI bayraklarla kosuyor; "tetiklendi mi" sorusuna
 * ise git'siz (`ls`) bakiliyor.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Docker from "dockerode";
import {
  initWorkspace,
  makeCheckpoint,
  diffFromCheckpoint,
  execCapture,
} from "@agent-rooms/core";

const docker = new Docker();
const IMAGE = "agent-rooms/room:dev";
const NAME = "gitkit-probe";
const WD = "/room/worktrees/backend";
/** gitkit'in kullandigi korumali bayraklar — dogrulama git'i de bunlari kullanir. */
const SAFE = `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.untrackedCache=false -c safe.directory="*"`;

const root = await fs.mkdtemp(path.join(os.tmpdir(), "gitkit-probe-"));
const ws = path.join(root, "worktrees", "backend");
await fs.mkdir(ws, { recursive: true });
await fs.writeFile(path.join(ws, "order.js"), "function processOrder(o) {\n  return o;\n}\n", "utf8");
await fs.writeFile(path.join(ws, "package.json"), '{\n  "version": "0.1.0"\n}\n', "utf8");

let fails = 0;
const check = (ok, msg) => {
  console.log(`${ok ? "  OK  " : " FAIL "} ${msg}`);
  if (!ok) fails++;
};

await docker.getContainer(NAME).remove({ force: true }).catch(() => undefined);

const container = await docker.createContainer({
  Image: IMAGE,
  name: NAME,
  WorkingDir: "/room",
  HostConfig: { Binds: [`${root.replace(/\\/g, "/")}:/room`] },
});
await container.start();

const sh = async (cmd, user = "agent") =>
  execCapture({ container: NAME, cmd: ["bash", "-lc", cmd], user, timeoutMs: 30_000 });
const git = async (args) => (await sh(`git ${SAFE} -C ${WD} ${args}`)).stdout.trim();
const ROOM = "11111111-1111-4111-8111-111111111111";

try {
  // --- 1. taban ---
  const init = await initWorkspace(NAME, WD);
  check(/^cp_[0-9a-f]{12}$/.test(init.checkpointId), `taban checkpoint: ${init.checkpointId}`);
  check(init.created === true, "workspace depoya cevrildi");
  check(
    (await git(`rev-parse --verify refs/rooms/checkpoints/${init.checkpointId}`)) === init.commitSha,
    "ref container icinde cozuluyor",
  );

  // --- 2. guvenlik: agent .git/config ve hook ekiyor ---
  await sh(`printf '\\n[core]\\n\\tfsmonitor = touch /tmp/pwned\\n' >> ${WD}/.git/config`);
  await sh(
    `mkdir -p ${WD}/.git/hooks && printf '#!/bin/sh\\ntouch /tmp/pwned2\\n' > ${WD}/.git/hooks/post-commit && chmod +x ${WD}/.git/hooks/post-commit`,
  );

  const before = {
    head: await git("rev-parse HEAD"),
    status: await git("status --porcelain"),
    index: (await sh(`sha256sum ${WD}/.git/index 2>/dev/null || echo yok`)).stdout.trim(),
  };

  await fs.writeFile(
    path.join(ws, "order.js"),
    "// yeni satir\nfunction processOrder(o) {\n  return o;\n}\n",
    "utf8",
  );
  const manual = await makeCheckpoint(NAME, WD, "elle");
  const diff = await diffFromCheckpoint(ROOM, NAME, WD, init.checkpointId);

  // "Tetiklendi mi" sorusuna GIT'SIZ bak: git'in kendisi tetikleyicidir.
  const pwned = await sh(`test -e /tmp/pwned && echo VAR || echo yok`, "root");
  const pwned2 = await sh(`test -e /tmp/pwned2 && echo VAR || echo yok`, "root");
  check(pwned.stdout.trim() === "yok", "ekilmis fsmonitor TETIKLENMEDI (/tmp/pwned yok)");
  check(pwned2.stdout.trim() === "yok", "ekilmis post-commit hook TETIKLENMEDI (/tmp/pwned2 yok)");

  const after = {
    head: await git("rev-parse HEAD"),
    status: await git("status --porcelain"),
    index: (await sh(`sha256sum ${WD}/.git/index 2>/dev/null || echo yok`)).stdout.trim(),
  };
  check(before.head === after.head && after.head.length === 40, `HEAD degismedi (${after.head.slice(0, 8)})`);
  check(before.status === after.status, "status --porcelain degismedi");
  check(before.index === after.index, `.git/index degismedi (${after.index.slice(0, 16)})`);
  check(manual.checkpointId !== init.checkpointId, "manuel checkpoint ayri kimlik aldi");

  // --- 3. diff ---
  const orderDiff = diff.files.find((f) => f.path === "order.js");
  check(diff.files.length === 1, `diff tek dosya dondu (${diff.files.map((f) => f.path)})`);
  check(orderDiff?.status === "modified", "order.js modified");
  check(orderDiff?.patch?.includes("+// yeni satir") === true, "patch yeni satiri tasiyor");

  // --- 4. node_modules ---
  await fs.mkdir(path.join(ws, "node_modules", "x"), { recursive: true });
  await fs.writeFile(path.join(ws, "node_modules", "x", "index.js"), "module.exports=1\n");
  const diff2 = await diffFromCheckpoint(ROOM, NAME, WD, init.checkpointId);
  check(!diff2.files.some((f) => f.path.includes("node_modules")), "node_modules diff'e girmedi");

  // --- 5. redaction ---
  await fs.writeFile(
    path.join(ws, ".env.example"),
    "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\nAWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY\n",
    "utf8",
  );
  const diff3 = await diffFromCheckpoint(ROOM, NAME, WD, init.checkpointId);
  const env = diff3.files.find((f) => f.path === ".env.example");
  check(env !== undefined, ".env.example diff'te");
  check(env?.patch?.includes("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY") === false, "ham secret patch'te YOK");
  check(env?.patch?.includes("[redacted:") === true, "maskeleme isareti var");
  const patchLines = (env?.patch ?? "").split("\n").length;
  check(patchLines >= 6 && patchLines <= 12, `patch satir sayisi bozulmadi (${patchLines})`);
} finally {
  await container.remove({ force: true }).catch(() => undefined);
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
}

console.log(fails === 0 ? "\nTUMU GECTI" : `\n${fails} KONTROL DUSTU`);
process.exit(fails === 0 ? 0 : 1);
