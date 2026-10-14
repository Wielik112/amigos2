/**
 * Liczenie wolnych terminów (bez pre-generowanych slotów).
 *
 * Termin startu S dla usługi o czasie D jest wolny, gdy:
 *  - dzień mieści się w horyzoncie (dziś … dziś + max_days_ahead) i nie jest zamknięty (święto, wyjątek),
 *  - [S, S + D] mieści się w jednym przedziale godzin pracy (przerwa dzieli dzień na przedziały),
 *  - S ≥ teraz + min_notice_minutes,
 *  - żadna blokada usługi nie nachodzi na [S, S + D),
 *  - istnieje stanowisko usługi, na którym [S, S + D + zapas) nie nachodzi na inną aktywną wizytę (z jej zapasem)
 *    ani na blokadę stanowiska.
 * Te same reguły sprawdzamy przy zapisie (w transakcji, po zablokowaniu stanowisk), a nachodzenie wizyt
 * dodatkowo blokuje constraint bookings_no_overlap w bazie.
 */
const { TZ } = require("./config");
const SERVICES = require("../_uslugi.json");

/* ---------------- Czas lokalny (Europe/Warsaw) <-> UTC, także przy zmianie czasu ---------------- */

const dtf = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit" });
const parts = (date) => Object.fromEntries(dtf.formatToParts(date).map((p) => [p.type, p.value]));
const offsetMs = (date) => {
  const p = parts(date);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(date.getTime() / 1000) * 1000;
};

/** "2026-10-25" + 480 (minuty od północy) -> Date (UTC). */
function localToUtc(ymd, minutes) {
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  const off = offsetMs(new Date(guess));
  let t = guess - off;
  const off2 = offsetMs(new Date(t));
  if (off2 !== off) t = guess - off2;
  return new Date(t);
}

const localYmd = (date) => { const p = parts(date); return `${p.year}-${p.month}-${p.day}`; };
const localHm = (date) => { const p = parts(date); return `${p.hour}:${p.minute}`; };
const toMin = (hm) => { const [h, m] = String(hm).split(":").map(Number); return h * 60 + m; };
const fmtMin = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const addDays = (ymd, n) => { const d = new Date(ymd + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isoDow = (ymd) => { const d = new Date(ymd + "T12:00:00Z").getUTCDay(); return d === 0 ? 7 : d; };

/* ---------------- Polskie dni ustawowo wolne ---------------- */

function easter(y) {  // algorytm Meeusa/Jonesa/Butchera
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const holidayCache = new Map();
/** Mapa "RRRR-MM-DD" -> nazwa święta dla danego roku. */
function holidays(y) {
  if (holidayCache.has(y)) return holidayCache.get(y);
  const e = easter(y);
  const list = [
    [`${y}-01-01`, "Nowy Rok"], [`${y}-01-06`, "Trzech Króli"], [e, "Wielkanoc"], [addDays(e, 1), "Poniedziałek Wielkanocny"],
    [`${y}-05-01`, "Święto Pracy"], [`${y}-05-03`, "Święto Konstytucji 3 Maja"], [addDays(e, 49), "Zielone Świątki"],
    [addDays(e, 60), "Boże Ciało"], [`${y}-08-15`, "Wniebowzięcie NMP"], [`${y}-11-01`, "Wszystkich Świętych"],
    [`${y}-11-11`, "Święto Niepodległości"], [`${y}-12-25`, "Boże Narodzenie"], [`${y}-12-26`, "Drugi dzień świąt"],
  ];
  if (y >= 2025) list.push([`${y}-12-24`, "Wigilia"]);   // dzień wolny od 2025 r.
  const map = new Map(list);
  holidayCache.set(y, map);
  return map;
}
const holidayName = (ymd) => holidays(Number(ymd.slice(0, 4))).get(ymd) || null;

/* ---------------- Czas trwania ---------------- */

/**
 * Czas wizyty w minutach: base + suma minut wybranych opcji (zasady z services.duration_rules).
 * Pole jednokrotnego wyboru, którego klient jeszcze nie zaznaczył, liczy się jako najkrótsza opcja –
 * lista godzin jest wtedy realistyczna od początku i tylko się zawęża po wyborze.
 */
function durationFor(svc, details) {
  let total = Number(svc.base_minutes) || 0;
  const rules = svc.duration_rules || {};
  const fields = (SERVICES[svc.slug] || {}).fields || [];
  for (const [field, map] of Object.entries(rules)) {
    const v = details ? details[field] : undefined;
    const picked = Array.isArray(v) ? v : v ? [v] : [];
    const multi = (fields.find((f) => f.name === field) || {}).type === "checks";
    if (!picked.length && !multi) { const vals = Object.values(map).map(Number).filter(Number.isFinite); if (vals.length) total += Math.min(...vals); }
    for (const opt of picked) total += Number(map[opt]) || 0;
  }
  return Math.min(Math.max(total, 10), 600);
}

/* ---------------- Dostępność ---------------- */

/** Ładuje konfigurację usługi potrzebną do liczenia dostępności. */
async function loadService(db, where, param) {
  const { rows: [svc] } = await db.query(`SELECT * FROM services WHERE ${where}`, [param]);
  if (!svc) return null;
  const [{ rows: hours }, { rows: res }] = await Promise.all([
    db.query("SELECT weekday, to_char(start_time, 'HH24:MI') AS s, to_char(end_time, 'HH24:MI') AS e FROM service_hours WHERE service_id = $1 ORDER BY weekday, start_time", [svc.id]),
    db.query(`SELECT r.id FROM service_resources sr JOIN resources r ON r.id = sr.resource_id
               WHERE sr.service_id = $1 AND r.active ORDER BY r.sort, r.id`, [svc.id]),
  ]);
  svc.hours = hours;
  svc.resourceIds = res.map((r) => r.id);
  return svc;
}

/** Godziny pracy dnia z gotowych danych: wyjątek usługi > wyjątek ogólny > święto > grafik tygodniowy. */
function windowsFor(svc, ymd, excRows) {
  const exc = excRows.find((e) => e.service_id === svc.id) || excRows.find((e) => e.service_id === null);
  if (exc) {
    if (exc.closed) return { windows: [], closed: exc.note || "Dzień wolny" };
    return { windows: [[toMin(exc.s), toMin(exc.e)]], closed: null, exception: exc.note || "Zmienione godziny" };
  }
  const hol = holidayName(ymd);
  if (hol && svc.closed_on_holidays) return { windows: [], closed: hol };
  const dow = isoDow(ymd);
  return { windows: svc.hours.filter((h) => h.weekday === dow).map((h) => [toMin(h.s), toMin(h.e)]), closed: null };
}

async function loadExceptions(db, svc, from, to) {
  const { rows } = await db.query(
    `SELECT service_id, to_char(day, 'YYYY-MM-DD') AS day, closed, to_char(start_time, 'HH24:MI') AS s, to_char(end_time, 'HH24:MI') AS e, note
       FROM schedule_exceptions WHERE day BETWEEN $1::date AND $2::date AND (service_id = $3 OR service_id IS NULL)`, [from, to, svc.id]);
  return rows;
}

/** Godziny pracy danego dnia jako przedziały minut [[od, do], …] + powód zamknięcia. */
async function dayWindows(db, svc, ymd) {
  return windowsFor(svc, ymd, await loadExceptions(db, svc, ymd, ymd));
}

/** Zajęte przedziały (aktywne wizyty z zapasem) i blokady na stanowiskach usługi w zakresie [from, to). */
async function loadBusy(db, svc, resources, from, to, excludeBooking) {
  const [{ rows: busy }, { rows: blocks }] = await Promise.all([
    db.query(
      `SELECT resource_id, start_at, block_until FROM bookings
        WHERE resource_id = ANY($1::int[]) AND start_at < $3 AND block_until > $2 AND ($4::uuid IS NULL OR id <> $4::uuid)
          AND (status = 'confirmed' OR (status = 'pending_payment' AND hold_expires_at > now()))`,
      [resources, from, to, excludeBooking || null]),
    db.query(
      `SELECT service_id, resource_id, start_at, end_at FROM time_blocks
        WHERE (service_id = $1 OR resource_id = ANY($2::int[])) AND start_at < $4 AND end_at > $3`,
      [svc.id, resources, from, to]),
  ]);
  return { busy, blocks };
}

const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && aEnd > bStart;

/** Czyste liczenie startów dla jednego dnia (bez zapytań do bazy). */
function computeStarts(svc, ymd, windows, resources, { busy, blocks }, opts) {
  const now = opts.now || new Date();
  const duration = opts.duration;
  const buffer = Number(svc.buffer_minutes) || 0;
  const minStart = opts.ignoreNotice ? -Infinity : now.getTime() + (Number(svc.min_notice_minutes) || 0) * 60000;
  const step = opts.step || Number(svc.step_minutes) || 30;
  const starts = [];
  for (const [wStart, wEnd] of windows) {
    for (let m = wStart; m + duration <= wEnd; m += step) {
      const s = localToUtc(ymd, m).getTime();
      if (s < minStart) continue;
      const e = s + duration * 60000;
      const until = e + buffer * 60000;
      if (blocks.some((b) => b.service_id === svc.id && !b.resource_id && overlaps(s, e, b.start_at.getTime(), b.end_at.getTime()))) continue;
      const free = resources.filter((r) =>
        !busy.some((b) => b.resource_id === r && overlaps(s, until, b.start_at.getTime(), b.block_until.getTime())) &&
        !blocks.some((b) => b.resource_id === r && overlaps(s, e, b.start_at.getTime(), b.end_at.getTime())));
      if (free.length) starts.push({ time: fmtMin(m), end: fmtMin(m + duration), start: new Date(s), endAt: new Date(e), resources: free });
    }
  }
  return starts;
}

/**
 * Wolne godziny startu dla usługi w danym dniu.
 * opts: { duration, now, ignoreNotice, onlyResource, excludeBooking, step }
 * Zwraca { duration, closed, starts: [{ time, end, start: Date, endAt: Date, resources: [id…] }] }.
 */
async function freeStarts(db, svc, ymd, opts = {}) {
  const now = opts.now || new Date();
  const duration = opts.duration || durationFor(svc, {});
  const today = localYmd(now);
  const out = { duration, closed: null, starts: [] };
  if (!opts.ignoreNotice && (ymd < today || ymd > addDays(today, svc.max_days_ahead))) return { ...out, closed: "Poza zakresem rezerwacji" };
  const { windows, closed } = await dayWindows(db, svc, ymd);
  if (closed) return { ...out, closed };
  const resources = opts.onlyResource ? [opts.onlyResource] : svc.resourceIds;
  if (!windows.length || !resources.length) return out;
  const data = await loadBusy(db, svc, resources, localToUtc(ymd, 0), localToUtc(addDays(ymd, 1), 0), opts.excludeBooking);
  out.starts = computeStarts(svc, ymd, windows, resources, data, { ...opts, now, duration });
  return out;
}

/**
 * Podsumowanie wolnych terminów dla wielu dni naraz (kalendarz w formularzu) – 3 zapytania niezależnie od liczby dni.
 * Zwraca { duration, from, to, days: { "RRRR-MM-DD": { n: liczba wolnych startów, first: "HH:MM" | null, closed: powód | null } } }.
 */
async function freeDays(db, svc, opts = {}) {
  const now = opts.now || new Date();
  const duration = opts.duration || durationFor(svc, {});
  const from = localYmd(now), to = addDays(from, svc.max_days_ahead);
  const resources = svc.resourceIds;
  const [exc, data] = await Promise.all([
    loadExceptions(db, svc, from, to),
    resources.length ? loadBusy(db, svc, resources, localToUtc(from, 0), localToUtc(addDays(to, 1), 0)) : { busy: [], blocks: [] },
  ]);
  const days = {};
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const { windows, closed } = windowsFor(svc, d, exc.filter((e) => e.day === d));
    if (closed || !windows.length || !resources.length) { days[d] = { n: 0, first: null, closed: closed || null }; continue; }
    const starts = computeStarts(svc, d, windows, resources, data, { now, duration });
    days[d] = { n: starts.length, first: starts.length ? starts[0].time : null, closed: null };
  }
  return { duration, from, to, days };
}

/**
 * Wolne stanowiska dla konkretnego startu (bez sprawdzania godzin pracy) – do rezerwacji wpisywanych w panelu.
 * Zwraca listę id stanowisk, na których [start, start + czas + zapas) nie koliduje z wizytą ani blokadą.
 */
async function resourcesFreeAt(db, svc, start, duration, opts = {}) {
  const resources = opts.onlyResource ? [opts.onlyResource] : svc.resourceIds;
  if (!resources.length) return [];
  const s = start.getTime(), e = s + duration * 60000, until = e + (Number(svc.buffer_minutes) || 0) * 60000;
  const [{ rows: busy }, { rows: blocks }] = await Promise.all([
    db.query(
      `SELECT resource_id FROM bookings
        WHERE resource_id = ANY($1::int[]) AND start_at < $3 AND block_until > $2 AND ($4::uuid IS NULL OR id <> $4::uuid)
          AND (status = 'confirmed' OR (status = 'pending_payment' AND hold_expires_at > now()))`,
      [resources, new Date(s), new Date(until), opts.excludeBooking || null]),
    db.query(
      `SELECT service_id, resource_id FROM time_blocks
        WHERE (service_id = $1 OR resource_id = ANY($2::int[])) AND start_at < $4 AND end_at > $3`,
      [svc.id, resources, new Date(s), new Date(e)]),
  ]);
  if (blocks.some((b) => b.service_id === svc.id && !b.resource_id)) return [];
  return resources.filter((r) => !busy.some((b) => b.resource_id === r) && !blocks.some((b) => b.resource_id === r));
}

module.exports = { freeStarts, freeDays, resourcesFreeAt, loadService, dayWindows, durationFor, holidays, holidayName, localToUtc, localYmd, localHm, toMin, fmtMin, addDays, isoDow };
