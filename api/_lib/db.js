const { Pool } = require("pg");
const { getConfig } = require("./config");

let pool = null;
let poolUrl = null;

function getPool() {
  const { databaseUrl } = getConfig();
  if (pool && poolUrl === databaseUrl) return pool;
  const ssl = /sslmode=require|neon\.tech|vercel-storage/.test(databaseUrl) ? { rejectUnauthorized: false } : undefined;
  pool = new Pool({ connectionString: databaseUrl, ssl, max: Number(process.env.DB_POOL_MAX) || 5, idleTimeoutMillis: 10000 });
  pool.on("error", (e) => console.error("[db] błąd połączenia", e.message));
  poolUrl = databaseUrl;
  return pool;
}

const query = (text, params) => getPool().query(text, params);

/** Transakcja: fn dostaje klienta; COMMIT po sukcesie, ROLLBACK po błędzie. */
async function tx(fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function closePool() {
  if (pool) { const p = pool; pool = null; poolUrl = null; await p.end(); }
}

module.exports = { query, tx, getPool, closePool };
