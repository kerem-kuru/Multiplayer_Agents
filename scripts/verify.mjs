/**
 * Hafta 1 kapısını uçtan uca doğrular. Tek komut:
 *
 *   npm run verify
 *
 * Sırayla: docker bekle → postgres + redis kaldır → healthy bekle →
 * migration uygula → smoke (oda → oturum → event → since=N ile geri oku).
 *
 * Makine yeni açıldıysa Docker Desktop'ın daemon'u geç gelir; bu script
 * 3 dakikaya kadar bekler.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd, args, { quiet = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: root,
      shell: process.platform === "win32",
      stdio: quiet ? "ignore" : "inherit",
    });
    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

async function waitFor(label, check, { timeoutMs = 180_000, everyMs = 2000 } = {}) {
  const started = Date.now();
  process.stdout.write(`${label} `);
  while (Date.now() - started < timeoutMs) {
    if (await check()) {
      console.log(`✓ (${Math.round((Date.now() - started) / 1000)}s)`);
      return true;
    }
    process.stdout.write(".");
    await sleep(everyMs);
  }
  console.log(" ✗ zaman aşımı");
  return false;
}

const dockerUp = async () => (await run("docker", ["info"], { quiet: true })) === 0;

const pgHealthy = async () =>
  (await run("docker", [
    "exec",
    "agent-rooms-postgres-1",
    "pg_isready",
    "-U",
    "rooms",
    "-d",
    "agent_rooms",
  ], { quiet: true })) === 0;

const steps = [
  async () => {
    if (await dockerUp()) return true;
    console.log("Docker daemon kapalı — Docker Desktop'ı açman gerekiyor.");
    return waitFor("docker daemon bekleniyor", dockerUp);
  },
  async () => {
    console.log("\n--- docker compose up ---");
    return (await run("docker", ["compose", "up", "-d", "postgres", "redis"])) === 0;
  },
  async () => waitFor("\npostgres hazırlanıyor", pgHealthy, { timeoutMs: 60_000 }),
  async () => {
    console.log("\n--- migrate ---");
    return (await run("node", ["scripts/migrate.mjs"])) === 0;
  },
  async () => {
    console.log("\n--- smoke (çekirdek) ---");
    return (await run("node", ["scripts/smoke.mjs"])) === 0;
  },
  async () => {
    console.log("\n--- oda imajı ---");
    return (
      (await run("docker", ["compose", "--profile", "build-only", "build", "room"])) === 0
    );
  },
  async () => {
    console.log("\n--- smoke (api) ---");
    return (await run("node", ["scripts/smoke-api.mjs"])) === 0;
  },
  async () => {
    console.log("\n--- Hafta 1 kapısı (10 kontrol) ---");
    return (await run("bash", ["scripts/week1-gate.sh"])) === 0;
  },
];

for (const step of steps) {
  if (!(await step())) {
    console.error("\nDoğrulama yarıda kaldı.");
    process.exit(1);
  }
}

console.log("\nHafta 1 kapısı geçildi.");
