/**
 * /api/admin/* – API panelu (vercel.json przepisuje /api/admin/<ścieżka> na /api/admin?path=<ścieżka>).
 * Wszystko poza POST login wymaga sesji admina (401 bez niej).
 */
const { query, tx } = require("./_lib/db");
const { TZ } = require("./_lib/config");
const { login, logout, requireAdmin } = require("./_lib/auth");
const { isLimited } = require("./_lib/ratelimit");
const { cancelBooking, expireHolds } = require("./_lib/bookings");
const { generateSlots } = require("./_lib/slots");
const { isRealDate, clean } = require("./_lib/validate");
const { getConfig } = require("./_lib/config");
const { HttpError, readBody, sendJson, getUrl, getIp, sameOrigin, handler } = require("./_lib/http");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ["pending_payment", "confirmed", "expired", "cancelled"];
const todayPL = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());

const LOCAL = (col) => `to_char(${col} AT TIME ZONE '${TZ}', 'YYYY-MM-DD')`;
const LOCAL_T = (col) => `to_char(${col} AT TIME ZONE '${TZ}', 'HH24:MI')`;
// status z uwzględnieniem holdu po czasie (zanim cron zapisze go jako expired)
const EFF = "(CASE WHEN b.status = 'pending_payment' AND b.hold_expires_at <= now() THEN 'expired' ELSE b.status END)";

/* ------------------------------ Rezerwacje ------------------------------ */

async function listBookings(q) {
  const from = isRealDate(q.get("od") || "") ? q.get("od") : todayPL();
  const to = isRealDate(q.get("do") || "") ? q.get("do") : null;
  const statuses = (q.get("status") || "").split(",").filter((s) => STATUSES.includes(s));
  const svc = q.get("usluga") || "";
  const { rows } = await query(
    `SELECT b.id, ${EFF} AS status, b.customer_name, b.phone, b.email, b.details, b.created_at,
            sv.slug, sv.name AS service_name, sv.uses_slots,
            s.start_at, ${LOCAL("s.start_at")} AS date, ${LOCAL_T("s.start_at")} AS time,
            p.status AS payment_status, p.amount, p.provider
       FROM bookings b
       JOIN services sv ON sv.id = b.service_id
       LEFT JOIN slots s ON s.id = b.slot_id
       LEFT JOIN payments p ON p.id = b.payment_id
      WHERE ($1 = '' OR sv.slug = $1)
        AND coalesce(s.start_at, b.created_at) >= ($2::date)::timestamp AT TIME ZONE '${TZ}'
        AND ($3::date IS NULL OR coalesce(s.start_at, b.created_at) < ($3::date + 1)::timestamp AT TIME ZONE '${TZ}')
        AND (cardinality($4::text[]) = 0 OR ${EFF} = ANY($4::text[]))
      ORDER BY coalesce(s.start_at, b.created_at), b.created_at
      LIMIT 500`,
    [svc, from, to, statuses]);
  return rows.map((r) => ({
    id: r.id, status: r.status, usluga: r.slug, uslugaNazwa: r.service_name, kontakt: !r.uses_slots,
    start: r.start_at, data: r.date, godzina: r.time, utworzono: r.created_at,
    klient: r.customer_name, telefon: r.phone, email: r.email, details: r.details,
    platnosc: r.payment_status ? { status: r.payment_status, kwota: r.amount, dostawca: r.provider } : null,
  }));
}

async function getBooking(id) {
  const { rows: [b] } = await query(
    `SELECT b.*, ${EFF} AS eff_status, sv.slug, sv.name AS service_name, sv.uses_slots,
            s.start_at, s.end_at, ${LOCAL("s.start_at")} AS date, ${LOCAL_T("s.start_at")} AS time, ${LOCAL_T("s.end_at")} AS time_end
       FROM bookings b JOIN services sv ON sv.id = b.service_id LEFT JOIN slots s ON s.id = b.slot_id
      WHERE b.id = $1`, [id]);
  if (!b) throw new HttpError(404, "Nie ma takiej rezerwacji.");
  const { rows: payments } = await query(
    "SELECT id, provider, provider_ref, amount, currency, status, created_at, updated_at FROM payments WHERE booking_id = $1 ORDER BY created_at", [id]);
  return {
    id: b.id, status: b.eff_status, usluga: b.slug, uslugaNazwa: b.service_name, kontakt: !b.uses_slots,
    start: b.start_at, koniec: b.end_at, data: b.date, godzina: b.time, godzinaDo: b.time_end, miejsce: b.seat,
    klient: b.customer_name, telefon: b.phone, email: b.email, details: b.details, notatki: b.notes,
    zgoda: b.consent_at, utworzono: b.created_at, potwierdzono: b.confirmed_at, holdDo: b.hold_expires_at,
    anulowano: b.cancelled_at, anulowal: b.cancelled_by, powod: b.cancel_reason,
    platnosci: payments.map((p) => ({ id: p.id, dostawca: p.provider, ref: p.provider_ref, kwota: p.amount, waluta: p.currency, status: p.status, utworzono: p.created_at, zmieniono: p.updated_at })),
    aktywnaPlatnosc: b.payment_id,
  };
}

/* -------------------------------- Usługi -------------------------------- */

const serviceOut = (s) => ({
  id: s.id, slug: s.slug, nazwa: s.name, zaliczka: s.deposit_amount, zaliczkaWymagana: s.deposit_required,
  dlugoscSlotu: s.slot_duration_minutes, aktywna: s.active, terminy: s.uses_slots,
});

async function updateService(id, body) {
  const sets = [], vals = [id];
  const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (body.zaliczka !== undefined) {
    const v = Number(body.zaliczka);
    if (!Number.isInteger(v) || v < 0 || v > 1000000) throw new HttpError(422, "Kwota zaliczki musi być liczbą groszy od 0 do 1 000 000.");
    add("deposit_amount", v);
  }
  if (body.zaliczkaWymagana !== undefined) add("deposit_required", body.zaliczkaWymagana === true);
  if (body.dlugoscSlotu !== undefined) {
    const v = Number(body.dlugoscSlotu);
    if (!Number.isInteger(v) || v < 5 || v > 480) throw new HttpError(422, "Długość slotu: od 5 do 480 minut.");
    add("slot_duration_minutes", v);
  }
  if (body.aktywna !== undefined) add("active", body.aktywna === true);
  if (!sets.length) throw new HttpError(422, "Brak zmian.");
  const { rows: [s] } = await query(`UPDATE services SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, vals);
  if (!s) throw new HttpError(404, "Nie ma takiej usługi.");
  if (s.deposit_required && s.deposit_amount <= 0) {
    await query("UPDATE services SET deposit_required = false WHERE id = $1", [id]);
    throw new HttpError(422, "Zaliczka wymagana, ale kwota wynosi 0 zł – ustaw kwotę większą od zera.");
  }
  return serviceOut(s);
}

/* ------------------------------ Grafik / sloty ------------------------------ */

async function listSlots(q) {
  const serviceId = Number(q.get("usluga"));
  const from = isRealDate(q.get("od") || "") ? q.get("od") : todayPL();
  const days = Math.min(Math.max(Number(q.get("dni")) || 7, 1), 31);
  if (!Number.isInteger(serviceId)) throw new HttpError(422, "Wybierz usługę.");
  const { rows } = await query(
    `SELECT s.id, s.start_at, s.end_at, s.capacity, s.blocked, ${LOCAL("s.start_at")} AS date,
            ${LOCAL_T("s.start_at")} AS time, ${LOCAL_T("s.end_at")} AS time_end,
            count(b.id) FILTER (WHERE b.status = 'confirmed')::int AS confirmed,
            count(b.id) FILTER (WHERE b.status = 'pending_payment' AND b.hold_expires_at > now())::int AS held,
            count(b.id)::int AS total
       FROM slots s LEFT JOIN bookings b ON b.slot_id = s.id
      WHERE s.service_id = $1
        AND s.start_at >= ($2::date)::timestamp AT TIME ZONE '${TZ}'
        AND s.start_at <  ($2::date + $3::int)::timestamp AT TIME ZONE '${TZ}'
      GROUP BY s.id ORDER BY s.start_at`, [serviceId, from, days]);
  return rows.map((r) => ({
    id: String(r.id), start: r.start_at, data: r.date, godzina: r.time, godzinaDo: r.time_end, pojemnosc: r.capacity,
    zablokowany: r.blocked, potwierdzone: r.confirmed, wstrzymane: r.held, historia: r.total, przeszly: r.start_at < new Date(),
  }));
}

async function blockSlots(body) {
  const blocked = body.zablokuj === true;
  if (Array.isArray(body.ids) && body.ids.length) {
    const ids = body.ids.map(Number).filter(Number.isInteger).slice(0, 500);
    const { rowCount } = await query("UPDATE slots SET blocked = $2 WHERE id = ANY($1::bigint[])", [ids, blocked]);
    return rowCount;
  }
  if (Number.isInteger(Number(body.usluga)) && isRealDate(body.dzien || "")) {
    const { rowCount } = await query(
      `UPDATE slots SET blocked = $3 WHERE service_id = $1
          AND start_at >= ($2::date)::timestamp AT TIME ZONE '${TZ}' AND start_at < ($2::date + 1)::timestamp AT TIME ZONE '${TZ}'`,
      [Number(body.usluga), body.dzien, blocked]);
    return rowCount;
  }
  throw new HttpError(422, "Wskaż sloty albo dzień.");
}

async function deleteSlot(id) {
  return tx(async (c) => {
    const { rows: [s] } = await c.query("SELECT id FROM slots WHERE id = $1 FOR UPDATE", [id]);
    if (!s) throw new HttpError(404, "Nie ma takiego slotu.");
    const { rows: [b] } = await c.query(
      `SELECT count(*) FILTER (WHERE status = 'confirmed' OR (status = 'pending_payment' AND hold_expires_at > now()))::int AS active,
              count(*)::int AS total FROM bookings WHERE slot_id = $1`, [id]);
    if (b.active) throw new HttpError(409, "Ten slot ma aktywną rezerwację – możesz go tylko zablokować dla kolejnych zapisów.");
    if (b.total) throw new HttpError(409, "Ten slot ma historię rezerwacji – możesz go zablokować, ale nie usunąć.");
    await c.query("DELETE FROM slots WHERE id = $1", [id]);
  });
}

/* ------------------------------ Powiadomienia ------------------------------ */

async function listNotifications() {
  const { rows: [{ unread }] } = await query("SELECT count(*)::int AS unread FROM notifications WHERE read_at IS NULL");
  const { rows } = await query(
    `SELECT n.id, n.type, n.read_at, n.created_at, b.id AS booking_id, b.customer_name, sv.name AS service_name,
            ${LOCAL("s.start_at")} AS date, ${LOCAL_T("s.start_at")} AS time
       FROM notifications n JOIN bookings b ON b.id = n.booking_id JOIN services sv ON sv.id = b.service_id
       LEFT JOIN slots s ON s.id = b.slot_id
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
  const path = (url.searchParams.get("path") || url.pathname.replace(/^\/api\/admin\/?/, "")).replace(/^\/+|\/+$/g, "");
  const seg = path.split("/");
  const m = req.method;
  const ok = (payload) => sendJson(res, 200, { ok: true, ...payload });

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
    if (seg.length === 1 && m === "GET") { await expireHolds(null).catch(() => {}); return ok({ rezerwacje: await listBookings(url.searchParams) }); }
    const id = seg[1];
    if (!UUID_RE.test(id || "")) throw new HttpError(404, "Nie ma takiej rezerwacji.");
    if (seg.length === 2 && m === "GET") return ok({ rezerwacja: await getBooking(id) });
    if (seg[2] === "anuluj" && m === "POST") {
      const body = await readBody(req);
      const { refund } = await cancelBooking(id, admin.login, clean(body.powod, 300) || null);
      return ok({ zwrot: refund, rezerwacja: await getBooking(id) });
    }
  }

  if (seg[0] === "uslugi") {
    if (seg.length === 1 && m === "GET") {
      const { rows } = await query("SELECT * FROM services ORDER BY sort, id");
      return ok({ uslugi: rows.map(serviceOut) });
    }
    if (seg.length === 2 && (m === "PATCH" || m === "POST") && /^\d+$/.test(seg[1])) return ok({ usluga: await updateService(Number(seg[1]), await readBody(req)) });
  }

  if (seg[0] === "sloty") {
    if (seg.length === 1 && m === "GET") return ok({ sloty: await listSlots(url.searchParams) });
    if (seg[1] === "generuj" && m === "POST") {
      const b = await readBody(req);
      const utworzono = await generateSlots({ serviceId: Number(b.usluga), from: b.od, to: b.do, weekdays: b.dni,
        timeFrom: b.godzinaOd, timeTo: b.godzinaDo, duration: Number(b.dlugosc), capacity: Number(b.pojemnosc || 1) });
      return ok({ utworzono });
    }
    if (seg[1] === "blokada" && m === "POST") return ok({ zmieniono: await blockSlots(await readBody(req)) });
    if (seg.length === 2 && m === "DELETE" && /^\d+$/.test(seg[1])) { await deleteSlot(Number(seg[1])); return ok({}); }
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
