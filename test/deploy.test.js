const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawnSync } = require("child_process");
const h = require("./helpers");

let env;
before(async () => { env = await h.setup(); await h.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public"); });
after(async () => { await env.close(); });

const build = (extra = {}) => spawnSync(process.execPath, ["scripts/vercel-build.js"], {
  cwd: path.join(__dirname, ".."), encoding: "utf8", timeout: 30000,
  env: { ...process.env, ADMIN_LOGIN: "", ADMIN_PASSWORD: "", ...extra },
});

test("build na Vercelu przygotowuje pustą bazę i nie odtwarza usuniętych slotów", async () => {
  let out = build();
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /ustaw ADMIN_PASSWORD/);
  let { rows: [a] } = await h.query("SELECT count(*)::int n FROM admin_users");
  assert.equal(a.n, 0, "bez ADMIN_PASSWORD nie powstaje konto z losowym hasłem");
  const { rows: [s] } = await h.query("SELECT count(*)::int n FROM services");
  assert.equal(s.n, 5);
  const { rows: [sl] } = await h.query("SELECT count(*)::int n FROM slots");
  assert.ok(sl.n > 0);

  await h.query("UPDATE services SET deposit_amount = 1234 WHERE slug = 'myjnia-reczna'");
  await h.query("DELETE FROM slots WHERE id IN (SELECT id FROM slots ORDER BY id LIMIT 10)");
  out = build({ ADMIN_LOGIN: "szef", ADMIN_PASSWORD: "haslo-z-vercela" });
  assert.equal(out.status, 0, out.stderr);
  const { rows: [sl2] } = await h.query("SELECT count(*)::int n FROM slots");
  assert.equal(sl2.n, sl.n - 10, "usunięte sloty nie wracają");
  const { rows: [d] } = await h.query("SELECT deposit_amount FROM services WHERE slug = 'myjnia-reczna'");
  assert.equal(d.deposit_amount, 1234, "ustawienia z panelu zostają");
  ({ rows: [a] } = await h.query("SELECT count(*)::int n FROM admin_users WHERE login = 'szef'"));
  assert.equal(a.n, 1);
  const login = await h.post(env.base, "/api/admin/login", { login: "szef", haslo: "haslo-z-vercela" });
  assert.equal(login.status, 200);
});

test("build zatrzymuje wdrożenie przy PAYMENTS_MODE=real bez kluczy, a bez bazy tylko ostrzega", () => {
  const real = build({ PAYMENTS_MODE: "real" });
  assert.equal(real.status, 1);
  assert.match(real.stderr, /STRIPE_SECRET_KEY/);
  const noDb = build({ DATABASE_URL: "" });
  assert.equal(noDb.status, 0);
  assert.match(noDb.stderr, /Brak DATABASE_URL/);
});

test("powrót z wycofanej wersji z grafikiem: sloty wracają, rezerwacje zostają, zapisy działają", async () => {
  const fs = require("fs");
  const ROOT = path.join(__dirname, "..");
  await h.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  // baza w stanie po wycofanej wersji: 001 + 002 (grafik, stanowiska) i rezerwacja na stanowisku
  await h.query(fs.readFileSync(path.join(ROOT, "api/_lib/sql/001_init.sql"), "utf8"));
  await h.query("CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  await h.query("INSERT INTO services (slug, name, deposit_amount, deposit_required, slot_duration_minutes, sort) VALUES ('myjnia-reczna', 'Myjnia ręczna', 5000, true, 30, 1)");
  await h.query(fs.readFileSync(path.join(__dirname, "fixtures/002_grafik_wycofany.sql"), "utf8"));
  await h.query("INSERT INTO schema_migrations VALUES ('001_init.sql'), ('002_grafik.sql')");
  await h.query("INSERT INTO resources (name) VALUES ('Myjnia 1'), ('Myjnia 2'); INSERT INTO service_resources SELECT 1, id FROM resources");
  await h.query("INSERT INTO service_hours (service_id, weekday, start_time, end_time) SELECT 1, d, '08:00', '16:00' FROM generate_series(1, 7) d");
  const start = new Date(Date.now() + 3 * 86400000);
  start.setUTCHours(9, 0, 0, 0);
  await h.query(`INSERT INTO bookings (service_id, resource_id, start_at, end_at, block_until, status, customer_name, phone, consent_at, confirmed_at)
                 VALUES (1, 1, $1, $1::timestamptz + interval '45 min', $1::timestamptz + interval '55 min', 'confirmed', 'Klient z grafiku', '+48600100200', now(), now())`, [start]);

  const out = build({ ADMIN_PASSWORD: "haslo-x" });
  assert.equal(out.status, 0, out.stderr);
  assert.equal((await h.query("SELECT to_regclass('resources') AS t")).rows[0].t, null, "tabele grafiku usunięte");
  const { rows: [b] } = await h.query("SELECT b.customer_name, b.seat, s.start_at FROM bookings b JOIN slots s ON s.id = b.slot_id");
  assert.equal(b.customer_name, "Klient z grafiku");
  assert.equal(b.seat, 1);
  assert.equal(b.start_at.toISOString(), start.toISOString());
  const { rows: [{ n }] } = await h.query("SELECT count(*)::int AS n FROM slots WHERE start_at > now()");
  assert.ok(n > 100, "sloty na 2 tygodnie z godzin pracy");
  const { rows: [cap] } = await h.query("SELECT max(capacity) AS c FROM slots");
  assert.equal(cap.c, 2, "pojemność = liczba stanowisk");
  // ponowne wdrożenie niczego nie psuje
  assert.equal(build().status, 0);
});
