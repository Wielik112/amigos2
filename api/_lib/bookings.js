/**
 * Logika terminów i rezerwacji.
 *
 * Statusy: pending_payment -> confirmed | expired | cancelled
 *
 * Ochrona przed podwójną rezerwacją (na poziomie bazy, dwie warstwy):
 *  1. SELECT … FOR UPDATE na wierszu slotu – równoległe transakcje na ten sam slot czekają w kolejce,
 *     a każda następna widzi już zatwierdzone rezerwacje poprzedniej;
 *  2. częściowy indeks unikalny bookings_active_seat (slot_id, seat) dla statusów aktywnych –
 *     nawet przy błędzie w kodzie dwie aktywne rezerwacje nie zajmą tego samego miejsca.
 *
 * Wygasłe holdy zwalniamy: przy każdym odczycie dostępności (zapytanie liczy tylko żywe holdy
 * i dodatkowo je oznacza), przy próbie rezerwacji danego slotu oraz w zadaniu cyklicznym (api/cron.js).
 */
const { query, tx } = require("./db");
const { getConfig, TZ } = require("./config");
const { HttpError } = require("./http");
const { getProvider, getProviderByName } = require("./payments");

// status widziany z zewnątrz: hold po czasie = wygasła, nawet zanim cron/rezerwacja zapisze to w bazie
const EFFECTIVE_STATUS = "(CASE WHEN b.status = 'pending_payment' AND b.hold_expires_at <= now() THEN 'expired' ELSE b.status END)";

const SLOT_TAKEN = "Ten termin właśnie został zajęty – wybierz inną godzinę.";

/** Oznacza wygasłe holdy jako expired (opcjonalnie tylko dla jednego slotu). Zwraca liczbę zwolnionych. */
async function expireHolds(client, slotId = null) {
  const db = client || { query };
  const { rows } = await db.query(
    `WITH exp AS (
       UPDATE bookings SET status = 'expired'
        WHERE status = 'pending_payment' AND hold_expires_at <= now() AND ($1::bigint IS NULL OR slot_id = $1)
       RETURNING payment_id),
     pay AS (
       UPDATE payments SET status = 'expired', updated_at = now()
        WHERE id IN (SELECT payment_id FROM exp WHERE payment_id IS NOT NULL) AND status = 'pending')
     SELECT count(*)::int AS n FROM exp`,
    [slotId]);
  return rows[0].n;
}

/** Wolne terminy usługi w danym dniu (dzień lokalny Europe/Warsaw). */
async function listAvailable(slug, ymd) {
  const { leadMinutes } = getConfig();
  const { rows } = await query(
    `SELECT s.id, s.start_at, s.end_at,
            to_char(s.start_at AT TIME ZONE '${TZ}', 'HH24:MI') AS time,
            s.capacity - count(b.id)::int AS free
       FROM slots s
       JOIN services sv ON sv.id = s.service_id
       LEFT JOIN bookings b ON b.slot_id = s.id
            AND (b.status = 'confirmed' OR (b.status = 'pending_payment' AND b.hold_expires_at > now()))
      WHERE sv.slug = $1 AND sv.active AND sv.uses_slots AND NOT s.blocked
        AND s.start_at > now() + make_interval(mins => $3)
        AND s.start_at >= ($2::date)::timestamp AT TIME ZONE '${TZ}'
        AND s.start_at <  ($2::date + 1)::timestamp AT TIME ZONE '${TZ}'
      GROUP BY s.id
     HAVING s.capacity - count(b.id) > 0
      ORDER BY s.start_at`,
    [slug, ymd, leadMinutes]);
  return rows.map((r) => ({ id: String(r.id), time: r.time, start: r.start_at.toISOString(), end: r.end_at.toISOString(), free: r.free }));
}

const firstFreeSeat = (capacity, taken) => {
  const t = new Set(taken);
  for (let i = 1; i <= capacity; i++) if (!t.has(i)) return i;
  return null;
};

async function freeSeatFor(c, slot) {
  await expireHolds(c, slot.id);
  const { rows } = await c.query(
    "SELECT seat FROM bookings WHERE slot_id = $1 AND status IN ('pending_payment', 'confirmed')", [slot.id]);
  return firstFreeSeat(slot.capacity, rows.map((r) => r.seat));
}

async function addNotification(c, bookingId, type, read = false) {
  await c.query(
    `INSERT INTO notifications (booking_id, type, read_at) VALUES ($1, $2, CASE WHEN $3 THEN now() END)
     ON CONFLICT (booking_id, type) DO NOTHING`, [bookingId, type, read]);
}

/**
 * Tworzy rezerwację z danych po validateBooking().
 * Zwraca { booking, status, redirectUrl|null }.
 */
async function createBooking(data) {
  const cfg = getConfig();
  const provider = getProvider();

  let created;
  try {
    created = await tx(async (c) => {
      const { rows: [svc] } = await c.query("SELECT * FROM services WHERE slug = $1 AND active", [data.slug]);
      if (!svc) throw new HttpError(422, "Tej usługi nie można teraz zarezerwować online – zadzwoń do nas.", { fields: ["usluga"] });

      let slot = null, seat = null;
      if (svc.uses_slots) {
        const { rows: [s] } = await c.query(
          `SELECT * FROM slots WHERE service_id = $1 AND start_at = ($2::date + $3::time) AT TIME ZONE '${TZ}' FOR UPDATE`,
          [svc.id, data.date, data.time]);
        const tooLate = s && s.start_at.getTime() <= Date.now() + cfg.leadMinutes * 60000;
        if (!s || s.blocked || tooLate) throw new HttpError(409, "Ten termin nie jest już dostępny – wybierz inną godzinę.", { code: "slot_unavailable", fields: ["godzina"] });
        seat = await freeSeatFor(c, s);
        if (seat === null) throw new HttpError(409, SLOT_TAKEN, { code: "slot_taken", fields: ["godzina"] });
        slot = s;
      }

      // kwota zaliczki zawsze z bazy, nigdy z żądania
      const needsPayment = svc.deposit_required && svc.deposit_amount > 0;
      const holdMinutes = Math.max(cfg.holdMinutes, provider.minHoldMinutes || 0);
      const { rows: [booking] } = await c.query(
        `INSERT INTO bookings (service_id, slot_id, seat, status, customer_name, phone, email, details, consent_at,
                               hold_expires_at, confirmed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(),
                 CASE WHEN $9 THEN now() + make_interval(mins => $10) END,
                 CASE WHEN $9 THEN NULL ELSE now() END)
         RETURNING *`,
        [svc.id, slot && slot.id, seat, needsPayment ? "pending_payment" : "confirmed", data.customerName, data.phone,
          data.email, JSON.stringify(data.details), needsPayment, holdMinutes]);

      let payment = null;
      if (needsPayment) {
        ({ rows: [payment] } = await c.query(
          "INSERT INTO payments (booking_id, provider, amount, currency, status) VALUES ($1, $2, $3, 'PLN', 'pending') RETURNING *",
          [booking.id, provider.name, svc.deposit_amount]));
        await c.query("UPDATE bookings SET payment_id = $2 WHERE id = $1", [booking.id, payment.id]);
        booking.payment_id = payment.id;
      } else {
        await addNotification(c, booking.id, "booking_confirmed");
      }
      return { booking, payment, svc, slot };
    });
  } catch (e) {
    if (e.code === "23505") throw new HttpError(409, SLOT_TAKEN, { code: "slot_taken", fields: ["godzina"] });
    throw e;
  }

  const { booking, payment, svc, slot } = created;
  if (!payment) return { booking, status: booking.status, redirectUrl: null };

  // Wywołanie dostawcy poza transakcją – nie trzymamy blokady slotu w czasie żądania do Stripe.
  try {
    const out = await provider.createPayment({ booking, payment, service: svc, slot });
    await query("UPDATE payments SET provider_ref = $2, updated_at = now() WHERE id = $1", [payment.id, out.providerRef]);
    return { booking, status: booking.status, redirectUrl: out.redirectUrl, paymentId: payment.id };
  } catch (e) {
    console.error("[rezerwacja] nie udało się utworzyć płatności", e.message);
    await tx(async (c) => {
      await c.query("UPDATE payments SET status = 'failed', updated_at = now() WHERE id = $1 AND status = 'pending'", [payment.id]);
      await c.query("UPDATE bookings SET status = 'expired' WHERE id = $1 AND status = 'pending_payment'", [booking.id]);
    });
    throw new HttpError(502, "Nie udało się rozpocząć płatności. Spróbuj ponownie za chwilę.");
  }
}

/**
 * Jedyne miejsce, w którym płatność zmienia status rezerwacji – wspólne dla mocka i Stripe.
 * Idempotentne: to samo zdarzenie (eventId) przetwarzamy raz, a stan końcowy nie zmienia się przy powtórzeniu.
 */
async function applyPaymentEvent(event) {
  if (!event || event.type === "ignored") return { ignored: true };
  return tx(async (c) => {
    if (event.eventId) {
      const { rowCount } = await c.query(
        "INSERT INTO processed_events (provider, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [event.provider, event.eventId]);
      if (!rowCount) return { duplicate: true };
    }
    const { rows: [payment] } = await c.query(
      `SELECT * FROM payments WHERE provider = $1 AND (($2::uuid IS NOT NULL AND id = $2::uuid) OR ($2::uuid IS NULL AND provider_ref = $3))
       FOR UPDATE`, [event.provider, event.paymentId || null, event.providerRef || null]);
    if (!payment) return { ignored: true, reason: "payment_not_found" };
    if (event.providerRef && payment.provider_ref && payment.provider_ref !== event.providerRef) return { ignored: true, reason: "ref_mismatch" };

    const { rows: [booking] } = await c.query("SELECT * FROM bookings WHERE id = $1 FOR UPDATE", [payment.booking_id]);

    if (event.type === "succeeded") {
      if (payment.status === "succeeded" || payment.status === "refunded") return { noop: true, status: booking.status };
      await c.query("UPDATE payments SET status = 'succeeded', updated_at = now() WHERE id = $1", [payment.id]);
      if (booking.payment_id !== payment.id) return { status: booking.status };

      let seat = booking.seat;
      const lapsed = booking.status === "expired" ||
        (booking.status === "pending_payment" && new Date(booking.hold_expires_at).getTime() <= Date.now());
      if (lapsed && !booking.slot_id) {
        seat = null;   // prośba o kontakt bez terminu – nie ma czego blokować
      } else if (lapsed) {
        // płatność dotarła po wygaśnięciu holdu: potwierdzamy tylko, jeśli miejsce nadal jest wolne
        const { rows: [slot] } = await c.query("SELECT * FROM slots WHERE id = $1 FOR UPDATE", [booking.slot_id]);
        seat = slot.blocked ? null : await freeSeatFor(c, slot);
        if (seat === null) {
          console.warn("[płatność] zaliczka po wygaśnięciu holdu, termin zajęty – do zwrotu", booking.id);
          return { status: "expired", needsRefund: true };
        }
      } else if (booking.status !== "pending_payment") {
        return { status: booking.status };   // np. anulowana w międzyczasie
      }
      await c.query(
        "UPDATE bookings SET status = 'confirmed', confirmed_at = now(), hold_expires_at = NULL, seat = $2 WHERE id = $1",
        [booking.id, seat]);
      await addNotification(c, booking.id, "booking_confirmed");
      return { status: "confirmed" };
    }

    if (event.type === "failed" || event.type === "expired") {
      if (payment.status === "pending") {
        await c.query("UPDATE payments SET status = $2, updated_at = now() WHERE id = $1", [payment.id, event.type]);
      }
      if (booking.status === "pending_payment" && booking.payment_id === payment.id) {
        await c.query("UPDATE bookings SET status = 'expired' WHERE id = $1", [booking.id]);
        return { status: "expired" };
      }
      return { status: booking.status };
    }
    return { ignored: true };
  });
}

/** Anulowanie przez admina. Termin wraca do puli (indeks liczy tylko statusy aktywne). */
async function cancelBooking(id, by, reason) {
  const out = await tx(async (c) => {
    const { rows: [b] } = await c.query("SELECT * FROM bookings WHERE id = $1 FOR UPDATE", [id]);
    if (!b) throw new HttpError(404, "Nie ma takiej rezerwacji.");
    if (b.status !== "pending_payment" && b.status !== "confirmed") throw new HttpError(409, "Tej rezerwacji nie można już anulować.");
    await c.query(
      "UPDATE bookings SET status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3, hold_expires_at = NULL WHERE id = $1",
      [id, by, reason || null]);
    let refund = null, toCancel = null;
    if (b.payment_id) {
      const { rows: [p] } = await c.query("SELECT * FROM payments WHERE id = $1 FOR UPDATE", [b.payment_id]);
      const provider = getProviderByName(p.provider);
      if (p.status === "succeeded") {
        refund = provider ? await provider.refund(p) : { supported: false, refunded: false, message: "Zwrot zaliczki zrób ręcznie u dostawcy płatności." };
        if (refund.refunded) await c.query("UPDATE payments SET status = 'refunded', updated_at = now() WHERE id = $1", [p.id]);
      } else if (p.status === "pending") {
        await c.query("UPDATE payments SET status = 'expired', updated_at = now() WHERE id = $1", [p.id]);
        toCancel = { provider, payment: p };
      }
    }
    await addNotification(c, id, "booking_cancelled", true);
    return { refund, toCancel };
  });
  if (out.toCancel && out.toCancel.provider && out.toCancel.provider.cancel) await out.toCancel.provider.cancel(out.toCancel.payment);
  return { refund: out.refund };
}

/** Status rezerwacji dla strony potwierdzenia (id rezerwacji = losowy UUID, pełni rolę tokenu). */
async function publicStatus(id) {
  const { rows: [r] } = await query(
    `SELECT b.id, ${EFFECTIVE_STATUS} AS status, b.hold_expires_at, b.customer_name, b.details, sv.name AS service_name, sv.slug, sv.uses_slots,
            to_char(s.start_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS date,
            to_char(s.start_at AT TIME ZONE '${TZ}', 'HH24:MI') AS time,
            p.id AS payment_id, p.status AS payment_status, p.amount, p.provider
       FROM bookings b JOIN services sv ON sv.id = b.service_id
       LEFT JOIN slots s ON s.id = b.slot_id
       LEFT JOIN payments p ON p.id = b.payment_id
      WHERE b.id = $1`, [id]);
  return r || null;
}

async function paymentInfo(paymentId) {
  const { rows: [r] } = await query(
    `SELECT p.id, CASE WHEN p.status = 'pending' AND ${EFFECTIVE_STATUS} = 'expired' THEN 'expired' ELSE p.status END AS status,
            p.amount, p.currency, p.provider, b.id AS booking_id, ${EFFECTIVE_STATUS} AS booking_status, b.hold_expires_at,
            sv.name AS service_name,
            to_char(s.start_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS date,
            to_char(s.start_at AT TIME ZONE '${TZ}', 'HH24:MI') AS time
       FROM payments p JOIN bookings b ON b.id = p.booking_id JOIN services sv ON sv.id = b.service_id
       LEFT JOIN slots s ON s.id = b.slot_id
      WHERE p.id = $1`, [paymentId]);
  return r || null;
}

module.exports = { createBooking, applyPaymentEvent, cancelBooking, listAvailable, expireHolds, publicStatus, paymentInfo, SLOT_TAKEN };
