/**
 * Migration koşucusu. db/migrations/*.sql dosyalarını ada göre sırayla uygular
 * ve uygulananları schema_migrations tablosunda tutar.
 *
 *   node scripts/migrate.mjs
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(root, "db", "migrations");

const connectionString =
  process.env.DATABASE_URL ?? "postgres://rooms:Kk2007..@localhost:5433/agent_rooms";

const client = new pg.Client({ connectionString });
await client.connect();

await client.query(`
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name       text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )
`);

const applied = new Set(
  (await client.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
);

const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();

let count = 0;
for (const file of files) {
  if (applied.has(file)) {
    console.log(`  atlandı  ${file}`);
    continue;
  }
  const sql = await readFile(path.join(migrationsDir, file), "utf8");
  try {
    await client.query("BEGIN");
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
    await client.query("COMMIT");
    console.log(`  uygulandı ${file}`);
    count++;
  } catch (err) {
    await client.query("ROLLBACK");
    console.error(`  HATA ${file}: ${err.message}`);
    await client.end();
    process.exit(1);
  }
}

console.log(count === 0 ? "Şema güncel." : `${count} migration uygulandı.`);
await client.end();
