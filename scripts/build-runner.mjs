/**
 * Kosum ortamlarini tek dosyaya paketler.
 *
 *   node scripts/build-runner.mjs
 *
 * Her kosum ortami BAGIMSIZ bir bundle: protocol ve zod icine girer, alttaki
 * agent CLI/SDK girmez (platforma gore native binary tasiyorlar, imaj kendi
 * icinde `npm install` ile kuruyor).
 */
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const RUNTIMES = [
  { kind: "claude", pkg: "runner", external: "@anthropic-ai/claude-agent-sdk" },
  { kind: "gemini", pkg: "runner-gemini", external: "@google/gemini-cli" },
];

for (const rt of RUNTIMES) {
  const pkgDir = path.join(root, "packages", rt.pkg);
  const outDir = path.join(pkgDir, "dist");
  const pkg = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
  const version = pkg.dependencies[rt.external];
  if (!version || /[\^~*]/.test(version)) {
    console.error(`${rt.kind}: ${rt.external} surumu tam sabitlenmeli, bulunan: ${version}`);
    process.exit(1);
  }

  await mkdir(outDir, { recursive: true });
  await build({
    entryPoints: [path.join(pkgDir, "src", "runner.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile: path.join(outDir, "runner.js"),
    external: [rt.external],
    logLevel: "warning",
  });

  await writeFile(
    path.join(outDir, "package.json"),
    JSON.stringify(
      {
        name: `agent-rooms-runner-${rt.kind}`,
        private: true,
        type: "module",
        dependencies: { [rt.external]: version },
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  console.log(`${rt.kind} paketlendi → packages/${rt.pkg}/dist/runner.js (${rt.external} ${version}, disarida)`);
}
