#!/usr/bin/env node
/** Uruchamia migracje z api/_lib/sql/*.sql (każdą raz, w kolejności nazw). */
const fs = require("fs");
const path = require("path");
require("./env").load();
const { tx, closePool } = require("../api/_lib/db");

const DIR = path.join(__dirname, "..", "api", "_lib", "sql");

async function migrate({ quiet = false } = {}) {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
  return tx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(424242)");
    await c.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const { rows } = await c.query("SELECT name FROM schema_migrations");
    const done = new Set(rows.map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      await c.query(fs.readFileSync(path.join(DIR, f), "utf8"));
      await c.query("INSERT INTO schema_migrations (name) VALUES ($1)", [f]);
      if (!quiet) console.log("migracja:", f);
    }
  });
}

module.exports = { migrate };

if (require.main === module) {
  migrate().then(() => { console.log("Baza aktualna."); return closePool(); })
    .catch((e) => { console.error("Migracja nie powiodła się:", e.message); process.exit(1); });
}
