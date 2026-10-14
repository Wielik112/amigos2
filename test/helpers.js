/**
 * Wspólne przygotowanie testów: osobna baza (TEST_DATABASE_URL), świeży schemat, seed, serwer HTTP na losowym porcie.
 * Domyślnie: postgres://amigos:amigos@localhost:5432/amigos_test
 */
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || "postgres://amigos:amigos@localhost:5432/amigos_test";
process.env.PAYMENTS_MODE = "mock";
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
  await seed({ quiet: true, adminLogin: ADMIN.login, adminPassword: ADMIN.haslo });
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

const { holidayName, addDays } = require("../api/_lib/availability");

/**
 * `days`-ty dzień roboczy (pon–pt, bez świąt), licząc od pojutrza + godzina – termin w grafiku.
 * Różne `days` = różne dni, więc testy nie zajmują sobie nawzajem terminów.
 */
function pick({ days = 3, time = "10:00" } = {}) {
  let d = addDays(ymdPL(new Date()), 1), n = 0;
  while (n < days) {
    d = addDays(d, 1);
    const dow = new Date(d + "T12:00:00Z").getUTCDay();
    if (dow >= 1 && dow <= 5 && !holidayName(d)) n++;
  }
  return { date: d, time };
}

const FORMS = {
  "myjnia-reczna": { pakiet: "Mycie ręczne nadwozia", pojazd: "Osobowy" },     // 45 min, 2 stanowiska
  "stacja-kontroli-pojazdow": { pojazd: "Osobowy", badanie: "Okresowe", rejestracja: "fnw 12345" },  // 30 min, 2 linie
  "geometria-kol-3d": { pojazd: "SUV", zakres: "Sam pomiar", "dodatkowo[]": ["Diagnostyka komputerowa"] },  // 45 min, 1 stanowisko
  "rejestracja-pojazdow": { sprawa: "Przerejestrowanie" },  // 20 min, Biuro
};

// każda rezerwacja testowa z innego numeru (ten sam numer + usługa + dzień = duplikat)
const randomPhone = () => "6" + String(crypto.randomInt(10 ** 8)).padStart(8, "0");

function bookingBody(slug, slot, extra = {}) {
  return { usluga: slug, ...FORMS[slug], data: slot.date, godzina: slot.time, imie: "Jan Testowy", telefon: randomPhone(),
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

module.exports = { setup, pick, bookingBody, randomPhone, post, get, adminCookie, query, ADMIN, ymdPL };
