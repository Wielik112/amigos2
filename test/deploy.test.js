const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const h = require("./helpers");

let env;
before(async () => { env = await h.setup(); });
after(async () => { await env.close(); });

const ROOT = path.join(__dirname, "..");
const reset = () => h.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
const build = (extra = {}) => spawnSync(process.execPath, ["scripts/vercel-build.js"], {
  cwd: ROOT, encoding: "utf8", timeout: 30000, env: { ...process.env, ADMIN_LOGIN: "", ADMIN_PASSWORD: "", ...extra },
});

test("build na Vercelu przygotowuje pustą bazę i nie nadpisuje zmian z panelu", async () => {
  await reset();
  let out = build();
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /ustaw ADMIN_PASSWORD/);
  let { rows: [a] } = await h.query("SELECT count(*)::int n FROM admin_users");
  assert.equal(a.n, 0, "bez ADMIN_PASSWORD nie powstaje konto z losowym hasłem");
  assert.equal((await h.query("SELECT count(*)::int n FROM services")).rows[0].n, 5);
  assert.equal((await h.query("SELECT count(*)::int n FROM resources")).rows[0].n, 6);
  assert.ok((await h.query("SELECT count(*)::int n FROM service_hours")).rows[0].n > 0);

  await h.query("UPDATE services SET deposit_amount = 1234, buffer_minutes = 25, duration_rules = '{\"pakiet\":{\"Pakiet komplet\":99}}' WHERE slug = 'myjnia-reczna'");
  await h.query("DELETE FROM service_hours WHERE weekday = 6");
  await h.query("UPDATE resources SET name = 'Linia A' WHERE name = 'Stacja kontroli – linia 1'");
  out = build({ ADMIN_LOGIN: "szef", ADMIN_PASSWORD: "haslo-z-vercela" });
  assert.equal(out.status, 0, out.stderr);
  const { rows: [m] } = await h.query("SELECT deposit_amount, buffer_minutes, duration_rules FROM services WHERE slug = 'myjnia-reczna'");
  assert.deepEqual(m, { deposit_amount: 1234, buffer_minutes: 25, duration_rules: { pakiet: { "Pakiet komplet": 99 } } }, "ustawienia z panelu zostają");
  assert.equal((await h.query("SELECT count(*)::int n FROM service_hours WHERE weekday = 6")).rows[0].n, 0, "usunięte godziny nie wracają");
  assert.equal((await h.query("SELECT count(*)::int n FROM resources WHERE name = 'Linia A'")).rows[0].n, 1);
  ({ rows: [a] } = await h.query("SELECT count(*)::int n FROM admin_users WHERE login = 'szef'"));
  assert.equal(a.n, 1);
  assert.equal((await h.post(env.base, "/api/admin/login", { login: "szef", haslo: "haslo-z-vercela" })).status, 200);
});

test("aktualizacja z wersji ze slotami: rezerwacje dostają czas i stanowisko", async () => {
  await reset();
  // stan bazy po pierwszej wersji (tylko migracja 001) z jedną potwierdzoną rezerwacją na slocie
  await h.query(fs.readFileSync(path.join(ROOT, "api/_lib/sql/001_init.sql"), "utf8"));
  await h.query("CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()); INSERT INTO schema_migrations VALUES ('001_init.sql')");
  await h.query("INSERT INTO services (slug, name, deposit_amount, deposit_required, slot_duration_minutes) VALUES ('myjnia-reczna', 'Myjnia ręczna', 5000, true, 30)");
  await h.query("INSERT INTO slots (service_id, start_at, end_at) VALUES (1, '2031-02-03T09:00:00Z', '2031-02-03T09:30:00Z')");
  await h.query(`INSERT INTO bookings (service_id, slot_id, seat, status, customer_name, phone, consent_at, confirmed_at)
                 VALUES (1, 1, 1, 'confirmed', 'Stary Klient', '+48600100200', now(), now())`);

  const out = build({ ADMIN_PASSWORD: "x-haslo" });
  assert.equal(out.status, 0, out.stderr);
  const { rows: [b] } = await h.query(
    "SELECT b.start_at, b.end_at, b.block_until, r.name FROM bookings b LEFT JOIN resources r ON r.id = b.resource_id");
  assert.equal(b.start_at.toISOString(), "2031-02-03T09:00:00.000Z");
  assert.equal(b.end_at.toISOString(), "2031-02-03T09:30:00.000Z");
  assert.equal(b.name, "Myjnia – stanowisko 1");
  const { rows: [s] } = await h.query("SELECT buffer_minutes, duration_rules->'pakiet'->>'Pakiet komplet' AS komplet FROM services WHERE slug = 'myjnia-reczna'");
  assert.deepEqual(s, { buffer_minutes: 10, komplet: "180" }, "usługa sprzed grafiku dostaje wartości domyślne");
  assert.equal((await h.query("SELECT to_regclass('slots') AS t")).rows[0].t, null);
});

test("build zatrzymuje wdrożenie przy PAYMENTS_MODE=real bez kluczy, a bez bazy tylko ostrzega", () => {
  const real = build({ PAYMENTS_MODE: "real" });
  assert.equal(real.status, 1);
  assert.match(real.stderr, /STRIPE_SECRET_KEY/);
  const noDb = build({ DATABASE_URL: "" });
  assert.equal(noDb.status, 0);
  assert.match(noDb.stderr, /Brak DATABASE_URL/);
});
