import pg from "pg";

const { Pool } = pg;

let pool: pg.Pool | null = null;

export function getPool(connectionString = process.env.DATABASE_URL): pg.Pool {
  if (pool) return pool;
  if (!connectionString) {
    throw new Error("DATABASE_URL tanımlı değil — .env.example dosyasını kopyala");
  }
  pool = new Pool({ connectionString, max: 10 });
  return pool;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  await pool.end();
  pool = null;
}

/** Tek transaction içinde çalıştır. Hata olursa rollback. */
export async function withTx<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
  p: pg.Pool = getPool(),
): Promise<T> {
  const client = await p.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
