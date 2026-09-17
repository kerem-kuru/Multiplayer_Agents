/**
 * Runner'ı tek dosyaya paketler.
 *
 *   node scripts/build-runner.mjs
 *
 * protocol ve zod bundle'a girer; SDK GİRMEZ. Sebebi: SDK'nın native Claude
 * Code binary'si platforma göre değişiyor — host'tan kopyalanırsa (örneğin
 * Apple Silicon host, linux/amd64 container) yanlış binary gelir. O yüzden
 * imaj kendi içinde `npm install` ile kuruyor.
 */
import { build } from "esbuild";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkgDir = path.join(root, "packages", "runner");
const outDir = path.join(pkgDir, "dist");

const pkg = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
const sdkVersion = pkg.dependencies["@anthropic-ai/claude-agent-sdk"];
if (!sdkVersion || /[\^~*]/.test(sdkVersion)) {
  console.error(`SDK surumu tam sabitlenmeli, bulunan: ${sdkVersion}`);
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
  external: ["@anthropic-ai/claude-agent-sdk"],
  logLevel: "warning",
});

// Imaj bu dosyayla `npm install --omit=dev` calistirir.
await writeFile(
  path.join(outDir, "package.json"),
  JSON.stringify(
    { name: "agent-rooms-runner", private: true, type: "module", dependencies: { "@anthropic-ai/claude-agent-sdk": sdkVersion } },
    null,
    2,
  ) + "\n",
  "utf8",
);

console.log(`runner paketlendi → packages/runner/dist/runner.js (SDK ${sdkVersion}, dışarıda)`);
