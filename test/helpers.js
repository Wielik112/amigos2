/**
 * Wspólne przygotowanie testów: osobna baza (TEST_DATABASE_URL), świeży schemat, seed, serwer HTTP na losowym porcie.
 * Domyślnie: postgres://amigos:amigos@localhost:5432/amigos_test
 */
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || "postgres://amigos:amigos@localhost:5432/amigos_test";
process.env.PAYMENTS_MODE = "mock";
process.env.BOOKING_LEAD_MINUTES = "0";
process.env.DB_POOL_MAX = "20";
delete process.env.STRIPE_SECRET_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;

const crypto = require("crypto");
const { query, closePool } = require("../api/_lib/db");
const { seed } = require("../scripts/seed");
const { createServer } = require("../scripts/dev-server");

const ADMIN = { login: "admin", haslo: "test-haslo-123" };

async function setup() {
  await query("DROP SCHEMA public CASCADE; CREATE SCHEMA public");
  await seed({ quiet: true, adminLogin: ADMIN.login, adminPassword: ADMIN.haslo, days: 2 });
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.PUBLIC_BASE_URL = base;
  return {
    base,
    async close() { await new Promise((r) => server.close(r)); await closePool(); },
  };
}

const ymdPL = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Warsaw" }).format(d);

/** Slot testowy za `days` dni o godzinie `time` (czas polski). */
async function makeSlot(slug, { days = 3, time = "21:30", capacity = 1 } = {}) {
  const date = ymdPL(new Date(Date.now() + days * 86400000));
  const { rows: [s] } = await query(
    `INSERT INTO slots (service_id, start_at, end_at, capacity)
     SELECT id, ($2::date + $3::time) AT TIME ZONE 'Europe/Warsaw', ($2::date + $3::time + interval '30 min') AT TIME ZONE 'Europe/Warsaw', $4
       FROM services WHERE slug = $1
     ON CONFLICT (service_id, start_at) DO UPDATE SET capacity = EXCLUDED.capacity, blocked = false
     RETURNING id`, [slug, date, time, capacity]);
  return { id: s.id, date, time };
}

const FORMS = {
  "myjnia-reczna": { pakiet: "Pakiet komplet", pojazd: "Osobowy" },
  "stacja-kontroli-pojazdow": { pojazd: "Osobowy", badanie: "Okresowe", rejestracja: "fnw 12345" },
  "geometria-kol-3d": { pojazd: "SUV", zakres: "Sam pomiar", "dodatkowo[]": ["Diagnostyka komputerowa"] },
};

function bookingBody(slug, slot, extra = {}) {
  return { usluga: slug, ...FORMS[slug], data: slot.date, godzina: slot.time, imie: "Jan Testowy", telefon: "600 100 200",
    email: "jan@example.com", zgoda: true, ...extra };
}

async function post(base, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": "10.0." + crypto.randomInt(255) + "." + crypto.randomInt(255), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})), headers: res.headers };
}

async function get(base, path, headers = {}) {
  const res = await fetch(base + path, { headers });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function adminCookie(base) {
  const r = await post(base, "/api/admin/login", ADMIN);
  if (r.status !== 200) throw new Error("login failed " + r.status);
  return r.headers.get("set-cookie").split(";")[0];
}

module.exports = { setup, makeSlot, bookingBody, post, get, adminCookie, query, ADMIN, ymdPL };
