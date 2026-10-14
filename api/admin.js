/**
 * /api/admin/* – API panelu (vercel.json przepisuje /api/admin/<ścieżka> na /api/admin?path=<ścieżka>).
 * Wszystko poza POST login wymaga sesji admina (401 bez niej).
 */
const { query, tx } = require("./_lib/db");
const { TZ, getConfig } = require("./_lib/config");
const { login, logout, requireAdmin } = require("./_lib/auth");
const { isLimited } = require("./_lib/ratelimit");
const { cancelBooking, createManualBooking, expireHolds, EFFECTIVE_STATUS: EFF } = require("./_lib/bookings");
const av = require("./_lib/availability");
const { isRealDate, clean, normalizePhone, SERVICES, HM_RE } = require("./_lib/validate");
const DEFAULTS = require("./_lib/defaults");
const { HttpError, readBody, sendJson, getUrl, getIp, sameOrigin, handler } = require("./_lib/http");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ["pending_payment", "confirmed", "expired", "cancelled"];
const todayPL = () => av.localYmd(new Date());
const LOCAL = (col) => `to_char(${col} AT TIME ZONE '${TZ}', 'YYYY-MM-DD')`;
const LOCAL_T = (col) => `to_char(${col} AT TIME ZONE '${TZ}', 'HH24:MI')`;
const int = (v) => (Number.isInteger(Number(v)) && v !== "" && v !== null ? Number(v) : null);
const need = (cond, msg) => { if (!cond) throw new HttpError(422, msg); };
const db = { query };

/* ------------------------------ Rezerwacje ------------------------------ */

async function listBookings(q) {
  const from = isRealDate(q.get("od") || "") ? q.get("od") : todayPL();
  const to = isRealDate(q.get("do") || "") ? q.get("do") : null;
  const statuses = (q.get("status") || "").split(",").filter((s) => STATUSES.includes(s));
  const svc = q.get("usluga") || "";
  const search = clean(q.get("szukaj"), 40);
  const digits = search.replace(/[^\d]/g, "").slice(-9);
  const { rows } = await query(
    `SELECT b.id, ${EFF} AS status, b.customer_name, b.phone, b.email, b.details, b.created_at, b.source,
            sv.slug, sv.name AS service_name, sv.uses_slots, r.name AS resource_name,
            b.start_at, ${LOCAL("b.start_at")} AS date, ${LOCAL_T("b.start_at")} AS time, ${LOCAL_T("b.end_at")} AS time_end,
            p.status AS payment_status, p.amount, p.provider
       FROM bookings b
       JOIN services sv ON sv.id = b.service_id
       LEFT JOIN resources r ON r.id = b.resource_id
       LEFT JOIN payments p ON p.id = b.payment_id
      WHERE ($1 = '' OR sv.slug = $1)
        -- przy wyszukiwaniu pomijamy filtr dat (szukamy też w historii)
        AND ($5 <> '' OR coalesce(b.start_at, b.created_at) >= ($2::date)::timestamp AT TIME ZONE '${TZ}')
        AND ($5 <> '' OR $3::date IS NULL OR coalesce(b.start_at, b.created_at) < ($3::date + 1)::timestamp AT TIME ZONE '${TZ}')
        AND (cardinality($4::text[]) = 0 OR ${EFF} = ANY($4::text[]))
        AND ($5 = '' OR ($6 <> '' AND b.phone LIKE '%' || $6 || '%')
             OR replace(upper(coalesce(b.details->>'rejestracja', '')), ' ', '') LIKE '%' || replace(upper($5), ' ', '') || '%'
             OR b.customer_name ILIKE '%' || $5 || '%')
      ORDER BY coalesce(b.start_at, b.created_at), b.created_at
      LIMIT 500`,
    [svc, from, to, statuses, search, digits]);
  return rows.map((r) => ({
    id: r.id, status: r.status, usluga: r.slug, uslugaNazwa: r.service_name, kontakt: !r.uses_slots, zrodlo: r.source,
    start: r.start_at, data: r.date, godzina: r.time, godzinaDo: r.time_end, stanowisko: r.resource_name, utworzono: r.created_at,
    klient: r.customer_name, telefon: r.phone, email: r.email, details: r.details,
    platnosc: r.payment_status ? { status: r.payment_status, kwota: r.amount, dostawca: r.provider } : null,
  }));
}

async function getBooking(id) {
  const { rows: [b] } = await query(
    `SELECT b.*, ${EFF} AS eff_status, sv.slug, sv.name AS service_name, sv.uses_slots, r.name AS resource_name,
            ${LOCAL("b.start_at")} AS date, ${LOCAL_T("b.start_at")} AS time, ${LOCAL_T("b.end_at")} AS time_end
       FROM bookings b JOIN services sv ON sv.id = b.service_id LEFT JOIN resources r ON r.id = b.resource_id
      WHERE b.id = $1`, [id]);
  if (!b) throw new HttpError(404, "Nie ma takiej rezerwacji.");
  const { rows: payments } = await query(
    "SELECT id, provider, provider_ref, amount, currency, status, created_at, updated_at FROM payments WHERE booking_id = $1 ORDER BY created_at", [id]);
  return {
    id: b.id, status: b.eff_status, usluga: b.slug, uslugaNazwa: b.service_name, kontakt: !b.uses_slots, zrodlo: b.source,
    start: b.start_at, koniec: b.end_at, data: b.date, godzina: b.time, godzinaDo: b.time_end, stanowisko: b.resource_name,
    klient: b.customer_name, telefon: b.phone, email: b.email, details: b.details, notatki: b.notes,
    zgoda: b.consent_at, utworzono: b.created_at, potwierdzono: b.confirmed_at, holdDo: b.hold_expires_at,
    anulowano: b.cancelled_at, anulowal: b.cancelled_by, powod: b.cancel_reason,
    platnosci: payments.map((p) => ({ id: p.id, dostawca: p.provider, ref: p.provider_ref, kwota: p.amount, waluta: p.currency, status: p.status, utworzono: p.created_at, zmieniono: p.updated_at })),
    aktywnaPlatnosc: b.payment_id,
  };
}

async function manualBooking(body, admin) {
  const phone = normalizePhone(body.telefon);
  const name = clean(body.imie, 60);
  need(int(body.usluga), "Wybierz usługę.");
  need(isRealDate(body.data || ""), "Wybierz dzień.");
  need(HM_RE.test(body.godzina || ""), "Wybierz godzinę.");
  need(name.length >= 2, "Podaj imię klienta.");
  need(phone, "Podaj 9-cyfrowy numer telefonu.");
  const duration = body.czas ? int(body.czas) : null;
  need(duration === null || (duration >= 5 && duration <= 600), "Czas wizyty: od 5 do 600 minut.");
  const booking = await createManualBooking({
    serviceId: int(body.usluga), date: body.data, time: body.godzina, duration, resourceId: int(body.stanowisko) || null,
    outsideHours: body.pozaGrafikiem === true, name, phone, email: clean(body.email, 100) || null, notes: clean(body.notatka, 300) || null,
  }, admin.login);
  return getBooking(booking.id);
}

/* ------------------------------ Kalendarz dnia ------------------------------ */

async function dayCalendar(day) {
  need(isRealDate(day), "Niepoprawna data.");
  const from = av.localToUtc(day, 0), to = av.localToUtc(av.addDays(day, 1), 0);
  const [{ rows: resources }, { rows: bookings }, { rows: blocks }, { rows: services }] = await Promise.all([
    query(`SELECT r.id, r.name, r.active, coalesce(array_agg(sr.service_id ORDER BY sr.service_id) FILTER (WHERE sr.service_id IS NOT NULL), '{}') AS services
             FROM resources r LEFT JOIN service_resources sr ON sr.resource_id = r.id GROUP BY r.id ORDER BY r.sort, r.id`),
    query(`SELECT b.id, b.resource_id, b.start_at, b.end_at, b.block_until, ${EFF} AS status, b.customer_name, b.phone, b.source,
                  sv.id AS service_id, sv.name AS service_name, ${LOCAL_T("b.start_at")} AS time, ${LOCAL_T("b.end_at")} AS time_end
             FROM bookings b JOIN services sv ON sv.id = b.service_id
            WHERE b.start_at < $2 AND b.end_at > $1 AND ${EFF} IN ('confirmed', 'pending_payment')
            ORDER BY b.start_at`, [from, to]),
    query(`SELECT t.id, t.service_id, t.resource_id, t.start_at, t.end_at, t.reason, ${LOCAL_T("t.start_at")} AS time, ${LOCAL_T("t.end_at")} AS time_end
             FROM time_blocks t WHERE t.start_at < $2 AND t.end_at > $1 ORDER BY t.start_at`, [from, to]),
    query("SELECT id FROM services WHERE uses_slots ORDER BY sort"),
  ]);
  // zakres siatki: od najwcześniejszego otwarcia do najpóźniejszego zamknięcia ze wszystkich usług
  let open = 8 * 60, close = 18 * 60;
  const closed = {}, windows = {};
  for (const s of services) {
    const svc = await av.loadService(db, "id = $1", s.id);
    const w = await av.dayWindows(db, svc, day);
    if (w.closed) closed[s.id] = w.closed;
    windows[s.id] = w.windows.map(([a, b]) => [av.fmtMin(a), av.fmtMin(b)]);
    for (const [a, b] of w.windows) { open = Math.min(open, a); close = Math.max(close, b); }
  }
  for (const b of bookings) {
    const s = av.toMin(b.time), e = b.time_end <= b.time ? 24 * 60 : av.toMin(b.time_end);
    open = Math.min(open, s); close = Math.max(close, e);
  }
  return {
    dzien: day, swieto: av.holidayName(day), od: av.fmtMin(Math.floor(open / 60) * 60), do: av.fmtMin(Math.min(24 * 60, Math.ceil(close / 60) * 60)),
    zamkniete: closed, godzinyPracy: windows,
    stanowiska: resources.map((r) => ({ id: r.id, nazwa: r.name, aktywne: r.active, uslugi: r.services })),
    rezerwacje: bookings.map((b) => ({ id: b.id, stanowisko: b.resource_id, usluga: b.service_id, uslugaNazwa: b.service_name, status: b.status,
      klient: b.customer_name, telefon: b.phone, zrodlo: b.source, godzina: b.time, godzinaDo: b.time_end,
      zapasMin: Math.round((b.block_until - b.end_at) / 60000) })),
    blokady: blocks.map((t) => ({ id: t.id, usluga: t.service_id, stanowisko: t.resource_id, godzina: t.time, godzinaDo: t.time_end, powod: t.reason })),
  };
}

/* -------------------------------- Usługi -------------------------------- */

async function servicesOut() {
  const [{ rows }, { rows: links }] = await Promise.all([
    query("SELECT * FROM services ORDER BY sort, id"),
    query("SELECT service_id, resource_id FROM service_resources"),
  ]);
  return rows.map((s) => ({
    id: s.id, slug: s.slug, nazwa: s.name, zaliczka: s.deposit_amount, zaliczkaWymagana: s.deposit_required, aktywna: s.active,
    terminy: s.uses_slots, czasBazowy: s.base_minutes, zapas: s.buffer_minutes, krok: s.step_minutes, wyprzedzenie: s.min_notice_minutes,
    horyzont: s.max_days_ahead, swietaZamkniete: s.closed_on_holidays, czasy: s.duration_rules,
    stanowiska: links.filter((l) => l.service_id === s.id).map((l) => l.resource_id),
    pola: ((SERVICES[s.slug] || {}).fields || []).filter((f) => f.opts && f.type !== "select").map((f) => ({ nazwa: f.name, typ: f.type, opcje: f.opts })),
  }));
}

async function updateService(id, body) {
  const sets = [], vals = [id];
  const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  const num = (key, col, min, max, label) => {
    if (body[key] === undefined) return;
    const v = Number(body[key]);
    need(Number.isInteger(v) && v >= min && v <= max, `${label}: od ${min} do ${max}.`);
    add(col, v);
  };
  num("zaliczka", "deposit_amount", 0, 1000000, "Kwota zaliczki (w groszach)");
  num("czasBazowy", "base_minutes", 0, 480, "Czas bazowy (min)");
  num("zapas", "buffer_minutes", 0, 120, "Zapas po wizycie (min)");
  num("wyprzedzenie", "min_notice_minutes", 0, 10080, "Minimalne wyprzedzenie (min)");
  num("horyzont", "max_days_ahead", 1, 365, "Rezerwacja do przodu (dni)");
  if (body.krok !== undefined) { need([5, 10, 15, 20, 30, 60].includes(Number(body.krok)), "Co ile minut pokazywać godziny: 5, 10, 15, 20, 30 albo 60."); add("step_minutes", Number(body.krok)); }
  if (body.zaliczkaWymagana !== undefined) add("deposit_required", body.zaliczkaWymagana === true);
  if (body.aktywna !== undefined) add("active", body.aktywna === true);
  if (body.swietaZamkniete !== undefined) add("closed_on_holidays", body.swietaZamkniete === true);
  if (body.czasy !== undefined) {
    const { rows: [s] } = await query("SELECT slug FROM services WHERE id = $1", [id]);
    need(s, "Nie ma takiej usługi.");
    const fields = (SERVICES[s.slug] || {}).fields || [];
    const rules = {};
    for (const [field, map] of Object.entries(body.czasy || {})) {
      const f = fields.find((x) => x.name === field && x.opts);
      if (!f) continue;
      rules[field] = {};
      for (const [opt, min] of Object.entries(map || {})) {
        if (!f.opts.includes(opt)) continue;
        const v = Number(min);
        need(Number.isInteger(v) && v >= 0 && v <= 480, `Czas dla „${opt}”: od 0 do 480 minut.`);
        rules[field][opt] = v;
      }
    }
    add("duration_rules", JSON.stringify(rules));
  }
  await tx(async (c) => {
    if (sets.length) {
      const { rowCount } = await c.query(`UPDATE services SET ${sets.join(", ")} WHERE id = $1`, vals);
      if (!rowCount) throw new HttpError(404, "Nie ma takiej usługi.");
    }
    if (Array.isArray(body.stanowiska)) {
      const ids = body.stanowiska.map(int).filter(Boolean);
      await c.query("DELETE FROM service_resources WHERE service_id = $1", [id]);
      if (ids.length) await c.query("INSERT INTO service_resources SELECT $1, unnest($2::int[]) ON CONFLICT DO NOTHING", [id, ids]);
    }
    const { rows: [s] } = await c.query("SELECT deposit_required, deposit_amount, uses_slots FROM services WHERE id = $1", [id]);
    if (!s) throw new HttpError(404, "Nie ma takiej usługi.");
    if (s.deposit_required && s.deposit_amount <= 0) throw new HttpError(422, "Zaliczka wymagana, ale kwota wynosi 0 zł – ustaw kwotę większą od zera.");
    if (s.uses_slots && Array.isArray(body.stanowiska) && !body.stanowiska.length) throw new HttpError(422, "Usługa musi mieć co najmniej jedno stanowisko – inaczej nikt nie zarezerwuje terminu.");
  });
  return (await servicesOut()).find((s) => s.id === id);
}

async function resetDurations(id) {
  const { rows: [s] } = await query("SELECT slug FROM services WHERE id = $1", [id]);
  need(s, "Nie ma takiej usługi.");
  const d = DEFAULTS.services[s.slug];
  need(d, "Brak domyślnych czasów dla tej usługi.");
  await query("UPDATE services SET duration_rules = $2, base_minutes = $3 WHERE id = $1", [id, JSON.stringify(d.durations), d.base]);
  return (await servicesOut()).find((x) => x.id === id);
}

/* ------------------------------ Grafik ------------------------------ */

async function getSchedule(serviceId) {
  const { rows: hours } = await query(
    "SELECT weekday, to_char(start_time, 'HH24:MI') AS od, to_char(end_time, 'HH24:MI') AS do FROM service_hours WHERE service_id = $1 ORDER BY weekday, start_time",
    [serviceId]);
  const { rows: exc } = await query(
    `SELECT e.id, e.service_id, to_char(e.day, 'YYYY-MM-DD') AS day, e.closed, to_char(e.start_time, 'HH24:MI') AS od,
            to_char(e.end_time, 'HH24:MI') AS do, e.note
       FROM schedule_exceptions e WHERE (e.service_id = $1 OR e.service_id IS NULL) AND e.day >= $2::date ORDER BY e.day`,
    [serviceId, todayPL()]);
  const { rows: blocks } = await query(
    `SELECT t.id, t.resource_id, r.name AS resource_name, ${LOCAL("t.start_at")} AS day, ${LOCAL_T("t.start_at")} AS od, ${LOCAL_T("t.end_at")} AS do,
            ${LOCAL("t.end_at")} AS day_end, t.reason
       FROM time_blocks t LEFT JOIN resources r ON r.id = t.resource_id
      WHERE (t.service_id = $1 OR t.resource_id IN (SELECT resource_id FROM service_resources WHERE service_id = $1)) AND t.end_at > now()
      ORDER BY t.start_at`, [serviceId]);
  const today = todayPL();
  const holidays = [];
  for (let i = 0; i < 180; i++) { const d = av.addDays(today, i); const h = av.holidayName(d); if (h) holidays.push({ dzien: d, nazwa: h }); }
  return {
    godziny: hours.map((h) => ({ dzien: h.weekday, od: h.od, do: h.do })),
    wyjatki: exc.map((e) => ({ id: e.id, wszystkie: e.service_id === null, dzien: e.day, zamkniete: e.closed, od: e.od, do: e.do, notatka: e.note })),
    blokady: blocks.map((t) => ({ id: t.id, stanowisko: t.resource_name, dzien: t.day, od: t.od, do: t.do, dzienDo: t.day_end, powod: t.reason })),
    swieta: holidays,
  };
}

async function saveHours(serviceId, list) {
  need(Array.isArray(list), "Brak godzin.");
  const rows = list.map((h) => ({ d: int(h.dzien), od: h.od, do: h.do }));
  for (const r of rows) {
    need(r.d >= 1 && r.d <= 7 && HM_RE.test(r.od || "") && HM_RE.test(r.do || ""), "Niepoprawne godziny.");
    need(r.do > r.od, "Godzina zamknięcia musi być późniejsza niż otwarcia.");
  }
  for (let d = 1; d <= 7; d++) {
    const day = rows.filter((r) => r.d === d).sort((a, b) => (a.od < b.od ? -1 : 1));
    for (let i = 1; i < day.length; i++) need(day[i].od >= day[i - 1].do, "Przedziały godzin w jednym dniu nie mogą na siebie nachodzić.");
  }
  await tx(async (c) => {
    await c.query("DELETE FROM service_hours WHERE service_id = $1", [serviceId]);
    for (const r of rows) await c.query("INSERT INTO service_hours (service_id, weekday, start_time, end_time) VALUES ($1, $2, $3, $4)", [serviceId, r.d, r.od, r.do]);
  });
  return getSchedule(serviceId);
}

async function addException(b) {
  need(isRealDate(b.dzien || ""), "Wybierz dzień.");
  const closed = b.zamkniete !== false;
  if (!closed) need(HM_RE.test(b.od || "") && HM_RE.test(b.do || "") && b.do > b.od, "Podaj godziny otwarcia w tym dniu.");
  const serviceId = b.wszystkie ? null : int(b.usluga);
  need(b.wszystkie || serviceId, "Wybierz usługę.");
  await query(
    `INSERT INTO schedule_exceptions (service_id, day, closed, start_time, end_time, note) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (coalesce(service_id, 0), day) DO UPDATE SET closed = EXCLUDED.closed, start_time = EXCLUDED.start_time,
       end_time = EXCLUDED.end_time, note = EXCLUDED.note`,
    [serviceId, b.dzien, closed, closed ? null : b.od, closed ? null : b.do, clean(b.notatka, 120) || null]);
  return conflictsOn(serviceId, b.dzien);
}

/** Aktywne wizyty, które wypadają w dniu ze zmienionym grafikiem – do ręcznego przełożenia. */
async function conflictsOn(serviceId, day) {
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM bookings b
      WHERE ($1::int IS NULL OR b.service_id = $1) AND (b.start_at AT TIME ZONE '${TZ}')::date = $2::date
        AND ${EFF} IN ('confirmed', 'pending_payment')`, [serviceId, day]);
  return { kolizje: rows[0].n };
}

async function addBlock(b, admin) {
  need(isRealDate(b.dzien || ""), "Wybierz dzień.");
  const allDay = b.caly === true;
  if (!allDay) need(HM_RE.test(b.od || "") && HM_RE.test(b.do || "") && b.do > b.od, "Podaj godziny blokady.");
  const resourceId = int(b.stanowisko) || null, serviceId = resourceId ? null : int(b.usluga);
  need(resourceId || serviceId, "Wybierz usługę albo stanowisko.");
  const start = av.localToUtc(b.dzien, allDay ? 0 : av.toMin(b.od));
  const end = allDay ? av.localToUtc(av.addDays(b.dzien, 1), 0) : av.localToUtc(b.dzien, av.toMin(b.do));
  await query("INSERT INTO time_blocks (service_id, resource_id, start_at, end_at, reason, created_by) VALUES ($1, $2, $3, $4, $5, $6)",
    [serviceId, resourceId, start, end, clean(b.powod, 120) || null, admin.login]);
  const { rows: [k] } = await query(
    `SELECT count(*)::int AS n FROM bookings b
      WHERE b.start_at < $3 AND b.end_at > $2 AND ${EFF} IN ('confirmed', 'pending_payment')
        AND (($1::int IS NOT NULL AND b.resource_id = $1) OR ($4::int IS NOT NULL AND b.service_id = $4))`,
    [resourceId, start, end, serviceId]);
  return { kolizje: k.n };
}

/* ------------------------------ Stanowiska ------------------------------ */

async function resourcesOut() {
  const { rows } = await query(
    `SELECT r.id, r.name, r.active, coalesce(array_agg(sr.service_id) FILTER (WHERE sr.service_id IS NOT NULL), '{}') AS services
       FROM resources r LEFT JOIN service_resources sr ON sr.resource_id = r.id GROUP BY r.id ORDER BY r.sort, r.id`);
  return rows.map((r) => ({ id: r.id, nazwa: r.name, aktywne: r.active, uslugi: r.services }));
}

/* ------------------------------ Powiadomienia ------------------------------ */

async function listNotifications() {
  const { rows: [{ unread }] } = await query("SELECT count(*)::int AS unread FROM notifications WHERE read_at IS NULL");
  const { rows } = await query(
    `SELECT n.id, n.type, n.read_at, n.created_at, b.id AS booking_id, b.customer_name, sv.name AS service_name,
            ${LOCAL("b.start_at")} AS date, ${LOCAL_T("b.start_at")} AS time
       FROM notifications n JOIN bookings b ON b.id = n.booking_id JOIN services sv ON sv.id = b.service_id
      ORDER BY n.created_at DESC, n.id DESC LIMIT 30`);
  return {
    nieprzeczytane: unread,
    lista: rows.map((r) => ({ id: String(r.id), typ: r.type, przeczytane: r.read_at, utworzono: r.created_at,
      rezerwacja: r.booking_id, klient: r.customer_name, usluga: r.service_name, data: r.date, godzina: r.time })),
  };
}

/* --------------------------------- Router --------------------------------- */

module.exports = handler(async (req, res) => {
  const url = getUrl(req);
  const q = url.searchParams;
  const path = (q.get("path") || url.pathname.replace(/^\/api\/admin\/?/, "")).replace(/^\/+|\/+$/g, "");
  const seg = path.split("/");
  const m = req.method;
  const ok = (payload) => sendJson(res, 200, { ok: true, ...payload });
  const idSeg = (i) => { const v = int(seg[i]); if (!v) throw new HttpError(404, "Nie znaleziono."); return v; };

  if (m !== "GET" && !sameOrigin(req)) throw new HttpError(403, "Niedozwolone źródło.");

  if (path === "login" && m === "POST") {
    if (await isLimited("login:" + getIp(req), 10, 15 * 60)) throw new HttpError(429, "Za dużo prób logowania. Spróbuj za 15 minut.");
    const body = await readBody(req);
    const out = await login(req, body.login, body.haslo);
    if (!out) throw new HttpError(401, "Nieprawidłowy login lub hasło.");
    return sendJson(res, 200, { ok: true, admin: out.user.login }, { "Set-Cookie": out.setCookie });
  }

  const admin = await requireAdmin(req);   // 401 bez sesji – dla wszystkiego poniżej

  if (path === "logout" && m === "POST") return sendJson(res, 200, { ok: true }, { "Set-Cookie": await logout(req) });
  if (path === "me" && m === "GET") return ok({ admin: admin.login, trybPlatnosci: getConfig().paymentsMode });

  if (seg[0] === "rezerwacje") {
    if (seg.length === 1 && m === "GET") { await expireHolds(null).catch(() => {}); return ok({ rezerwacje: await listBookings(q) }); }
    if (seg.length === 1 && m === "POST") return ok({ rezerwacja: await manualBooking(await readBody(req), admin) });
    const id = seg[1];
    if (!UUID_RE.test(id || "")) throw new HttpError(404, "Nie ma takiej rezerwacji.");
    if (seg.length === 2 && m === "GET") return ok({ rezerwacja: await getBooking(id) });
    if (seg[2] === "anuluj" && m === "POST") {
      const body = await readBody(req);
      const { refund } = await cancelBooking(id, admin.login, clean(body.powod, 300) || null);
      return ok({ zwrot: refund, rezerwacja: await getBooking(id) });
    }
  }

  if (path === "wolne" && m === "GET") {
    const svc = await av.loadService(db, "id = $1", int(q.get("usluga")));
    need(svc && svc.uses_slots, "Wybierz usługę.");
    need(isRealDate(q.get("dzien") || ""), "Wybierz dzień.");
    const duration = int(q.get("czas")) || av.durationFor(svc, {});
    const r = await av.freeStarts(db, svc, q.get("dzien"), { duration, ignoreNotice: true, step: 15, onlyResource: int(q.get("stanowisko")) || null });
    return ok({ czas: duration, zamkniete: r.closed, terminy: r.starts.map((s) => ({ godzina: s.time, do: s.end, wolne: s.resources.length })) });
  }

  if (path === "kalendarz" && m === "GET") return ok(await dayCalendar(q.get("dzien") || todayPL()));

  if (seg[0] === "uslugi") {
    if (seg.length === 1 && m === "GET") return ok({ uslugi: await servicesOut() });
    if (seg.length === 2 && (m === "PATCH" || m === "POST")) return ok({ usluga: await updateService(idSeg(1), await readBody(req)) });
    if (seg[2] === "domyslne-czasy" && m === "POST") return ok({ usluga: await resetDurations(idSeg(1)) });
  }

  if (seg[0] === "grafik") {
    if (seg.length === 2 && m === "GET") return ok(await getSchedule(idSeg(1)));
    if (seg[2] === "godziny" && m === "PUT") return ok(await saveHours(idSeg(1), (await readBody(req)).godziny));
  }

  if (seg[0] === "wyjatki") {
    if (seg.length === 1 && m === "POST") return ok(await addException(await readBody(req)));
    if (seg.length === 2 && m === "DELETE") { await query("DELETE FROM schedule_exceptions WHERE id = $1", [idSeg(1)]); return ok({}); }
  }

  if (seg[0] === "blokady") {
    if (seg.length === 1 && m === "POST") return ok(await addBlock(await readBody(req), admin));
    if (seg.length === 2 && m === "DELETE") { await query("DELETE FROM time_blocks WHERE id = $1", [idSeg(1)]); return ok({}); }
  }

  if (seg[0] === "stanowiska") {
    if (seg.length === 1 && m === "GET") return ok({ stanowiska: await resourcesOut() });
    if (seg.length === 1 && m === "POST") {
      const b = await readBody(req);
      const name = clean(b.nazwa, 60);
      need(name.length >= 2, "Podaj nazwę stanowiska.");
      await tx(async (c) => {
        const { rows: [r] } = await c.query("INSERT INTO resources (name, sort) VALUES ($1, (SELECT coalesce(max(sort), 0) + 1 FROM resources)) RETURNING id", [name]);
        const ids = (Array.isArray(b.uslugi) ? b.uslugi : []).map(int).filter(Boolean);
        if (ids.length) await c.query("INSERT INTO service_resources SELECT unnest($2::int[]), $1 ON CONFLICT DO NOTHING", [r.id, ids]);
      });
      return ok({ stanowiska: await resourcesOut() });
    }
    if (seg.length === 2 && m === "PATCH") {
      const b = await readBody(req);
      const id = idSeg(1);
      if (b.nazwa !== undefined) { const n = clean(b.nazwa, 60); need(n.length >= 2, "Podaj nazwę stanowiska."); await query("UPDATE resources SET name = $2 WHERE id = $1", [id, n]); }
      if (b.aktywne !== undefined) await query("UPDATE resources SET active = $2 WHERE id = $1", [id, b.aktywne === true]);
      return ok({ stanowiska: await resourcesOut() });
    }
    if (seg.length === 2 && m === "DELETE") {
      const id = idSeg(1);
      const { rows: [u] } = await query("SELECT count(*)::int AS n FROM bookings WHERE resource_id = $1", [id]);
      if (u.n) throw new HttpError(409, "To stanowisko ma historię rezerwacji – zamiast usuwać, wyłącz je (odznacz „aktywne”).");
      await query("DELETE FROM resources WHERE id = $1", [id]);
      return ok({ stanowiska: await resourcesOut() });
    }
  }

  if (seg[0] === "powiadomienia") {
    if (seg.length === 1 && m === "GET") return ok(await listNotifications());
    if (seg[1] === "przeczytane" && m === "POST") {
      const b = await readBody(req);
      if (b.wszystkie === true) await query("UPDATE notifications SET read_at = now() WHERE read_at IS NULL");
      else {
        const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter(Number.isInteger).slice(0, 200);
        await query("UPDATE notifications SET read_at = now() WHERE id = ANY($1::bigint[]) AND read_at IS NULL", [ids]);
      }
      return ok(await listNotifications());
    }
  }

  throw new HttpError(404, "Nie znaleziono.");
});
