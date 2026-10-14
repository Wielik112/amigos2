/**
 * Logika rezerwacji.
 *
 * Statusy: pending_payment -> confirmed | expired | cancelled
 *
 * Wolne godziny liczy availability.js (grafik tygodniowy, stanowiska, czas trwania zależny od wyboru klienta).
 * Ochrona przed podwójną rezerwacją (na poziomie bazy, dwie warstwy):
 *  1. SELECT … FOR UPDATE na stanowiskach usługi – równoległe zapisy na te same stanowiska idą po kolei,
 *     a każdy następny widzi już zatwierdzone rezerwacje poprzedniego;
 *  2. constraint bookings_no_overlap (EXCLUDE USING gist) – dwie aktywne wizyty na tym samym stanowisku
 *     nie mogą na siebie nachodzić, nawet przy błędzie w kodzie.
 *
 * Wygasłe holdy: dostępność liczy tylko żywe holdy; przy zapisie wygasłe holdy na stanowiskach usługi są
 * oznaczane jako expired (inaczej constraint by je liczył); dodatkowo porządkuje je cron (api/cron.js).
 */
const { query, tx } = require("./db");
const { getConfig, TZ } = require("./config");
const { HttpError } = require("./http");
const { getProvider, getProviderByName } = require("./payments");
const av = require("./availability");

// status widziany z zewnątrz: hold po czasie = wygasła, nawet zanim cron/rezerwacja zapisze to w bazie
const EFFECTIVE_STATUS = "(CASE WHEN b.status = 'pending_payment' AND b.hold_expires_at <= now() THEN 'expired' ELSE b.status END)";

const SLOT_TAKEN = "Ten termin właśnie został zajęty – wybierz inną godzinę.";
const taken = () => new HttpError(409, SLOT_TAKEN, { code: "slot_taken", fields: ["godzina"] });

/** Oznacza wygasłe holdy jako expired (opcjonalnie tylko na wskazanych stanowiskach). Zwraca liczbę zwolnionych. */
async function expireHolds(client, resourceIds = null) {
  const db = client || { query };
  const { rows } = await db.query(
    `WITH exp AS (
       UPDATE bookings SET status = 'expired'
        WHERE status = 'pending_payment' AND hold_expires_at <= now() AND ($1::int[] IS NULL OR resource_id = ANY($1::int[]))
       RETURNING payment_id),
     pay AS (
       UPDATE payments SET status = 'expired', updated_at = now()
        WHERE id IN (SELECT payment_id FROM exp WHERE payment_id IS NOT NULL) AND status = 'pending')
     SELECT count(*)::int AS n FROM exp`,
    [resourceIds]);
  return rows[0].n;
}

/** Blokuje stanowiska (w stałej kolejności – bez zakleszczeń) na czas transakcji i sprząta na nich wygasłe holdy. */
async function lockResources(c, ids) {
  if (!ids.length) return;
  await c.query("SELECT id FROM resources WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE", [ids]);
  await expireHolds(c, ids);
}

/** Wolne godziny dla formularza: { czas, zamkniete, terminy: [{ godzina, do, wolne }] }. */
async function listAvailable(slug, ymd, details) {
  const svc = await av.loadService({ query }, "slug = $1 AND active AND uses_slots", slug);
  if (!svc) return { duration: 0, closed: "Usługa niedostępna online", starts: [] };
  return av.freeStarts({ query }, svc, ymd, { duration: av.durationFor(svc, details) });
}

/** Wolne dni (kalendarz w formularzu). */
async function listDays(slug, details) {
  const svc = await av.loadService({ query }, "slug = $1 AND active AND uses_slots", slug);
  if (!svc) return { duration: 0, from: null, to: null, days: {} };
  return av.freeDays({ query }, svc, { duration: av.durationFor(svc, details) });
}

async function addNotification(c, bookingId, type, read = false) {
  await c.query(
    `INSERT INTO notifications (booking_id, type, read_at) VALUES ($1, $2, CASE WHEN $3 THEN now() END)
     ON CONFLICT (booking_id, type) DO NOTHING`, [bookingId, type, read]);
}

async function insertBooking(c, b) {
  const { rows: [booking] } = await c.query(
    `INSERT INTO bookings (service_id, resource_id, start_at, end_at, block_until, status, customer_name, phone, email,
                           details, notes, consent_at, hold_expires_at, confirmed_at, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
             CASE WHEN $6 = 'pending_payment' THEN now() + make_interval(mins => $13) END,
             CASE WHEN $6 = 'confirmed' THEN now() END, $14)
     RETURNING *`,
    [b.serviceId, b.resourceId, b.start, b.end, b.until, b.status, b.name, b.phone, b.email || null,
      JSON.stringify(b.details || {}), b.notes || null, b.consentAt, b.holdMinutes || 0, b.source || "online"]);
  return booking;
}

/** Ta sama osoba, ta sama usługa, ten sam dzień – nie tworzymy drugiej rezerwacji. */
async function findDuplicate(c, svc, phone, ymd) {
  const { rows: [d] } = await c.query(
    `SELECT to_char(start_at AT TIME ZONE '${TZ}', 'HH24:MI') AS time FROM bookings
      WHERE service_id = $1 AND phone = $2 AND start_at IS NOT NULL
        AND (start_at AT TIME ZONE '${TZ}')::date = $3::date
        AND (status = 'confirmed' OR (status = 'pending_payment' AND hold_expires_at > now()))
      LIMIT 1`, [svc.id, phone, ymd]);
  return d || null;
}

/**
 * Rezerwacja z formularza (dane po validateBooking()).
 * Zwraca { booking, status, redirectUrl|null }.
 */
async function createBooking(data) {
  const cfg = getConfig();
  const provider = getProvider();

  let created;
  try {
    created = await tx(async (c) => {
      const svc = await av.loadService(c, "slug = $1 AND active", data.slug);
      if (!svc) throw new HttpError(422, "Tej usługi nie można teraz zarezerwować online – zadzwoń do nas.", { fields: ["usluga"] });

      let slot = null;
      if (svc.uses_slots) {
        await lockResources(c, svc.resourceIds);
        const dup = await findDuplicate(c, svc, data.phone, data.date);
        if (dup) {
          throw new HttpError(409, `Masz już rezerwację tej usługi w tym dniu (godz. ${dup.time}). Jeśli chcesz ją zmienić, zadzwoń do nas.`,
            { code: "duplicate", fields: ["telefon"] });
        }
        const duration = av.durationFor(svc, data.details);
        const day = await av.freeStarts(c, svc, data.date, { duration });
        const hit = day.starts.find((s) => s.time === data.time);
        if (!hit) throw taken();
        slot = { resourceId: hit.resources[0], start: hit.start, end: hit.endAt,
          until: new Date(hit.endAt.getTime() + (Number(svc.buffer_minutes) || 0) * 60000) };
      }

      // kwota zaliczki zawsze z bazy, nigdy z żądania
      const needsPayment = svc.deposit_required && svc.deposit_amount > 0;
      const booking = await insertBooking(c, {
        serviceId: svc.id, resourceId: slot && slot.resourceId, start: slot && slot.start, end: slot && slot.end, until: slot && slot.until,
        status: needsPayment ? "pending_payment" : "confirmed", name: data.customerName, phone: data.phone, email: data.email,
        details: data.details, consentAt: new Date(), holdMinutes: Math.max(cfg.holdMinutes, provider.minHoldMinutes || 0),
      });

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
      return { booking, payment, svc };
    });
  } catch (e) {
    if (e.code === "23P01" || e.code === "23505") throw taken();   // constraint w bazie złapał nakładanie się wizyt
    throw e;
  }

  const { booking, payment, svc } = created;
  if (!payment) return { booking, status: booking.status, redirectUrl: null };

  // Wywołanie dostawcy poza transakcją – nie trzymamy blokady stanowisk w czasie żądania do Stripe.
  try {
    const out = await provider.createPayment({ booking, payment, service: svc, slot: booking.start_at ? { start_at: booking.start_at } : null });
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
 * Wybór terminu w panelu (rezerwacja telefoniczna, przełożenie): sprawdza godziny pracy (chyba że „poza grafikiem”),
 * wolne stanowisko i blokady. Bez minimalnego wyprzedzenia. Zwraca { resourceId, start, end, until }.
 */
async function pickAdminSlot(c, svc, o, { excludeBooking, preferResource } = {}) {
  const ids = o.resourceId ? [o.resourceId] : svc.resourceIds;
  if (o.resourceId && !svc.resourceIds.includes(o.resourceId)) throw new HttpError(422, "To stanowisko nie obsługuje tej usługi.");
  await lockResources(c, ids);
  const duration = o.duration;
  let free, start;
  if (o.outsideHours) {
    start = av.localToUtc(o.date, av.toMin(o.time));
    free = await av.resourcesFreeAt(c, svc, start, duration, { onlyResource: o.resourceId, excludeBooking });
  } else {
    const day = await av.freeStarts(c, svc, o.date, { duration, ignoreNotice: true, step: 5, onlyResource: o.resourceId, excludeBooking });
    const hit = day.starts.find((s) => s.time === o.time);
    if (!hit) {
      throw new HttpError(409, day.closed ? `Ten dzień jest zamknięty (${day.closed}). Zaznacz „poza grafikiem”, jeśli mimo to chcesz zapisać.`
        : "W tej godzinie nie ma wolnego stanowiska (albo jest poza godzinami pracy). Wybierz inną godzinę albo zaznacz „poza grafikiem”.");
    }
    free = hit.resources;
    start = hit.start;
  }
  if (!free.length) throw new HttpError(409, "Stanowisko jest w tym czasie zajęte – wybierz inną godzinę albo inne stanowisko.");
  const resourceId = free.includes(preferResource) ? preferResource : free[0];
  const end = new Date(start.getTime() + duration * 60000);
  return { resourceId, start, end, until: new Date(end.getTime() + (Number(svc.buffer_minutes) || 0) * 60000) };
}

/**
 * Rezerwacja wpisana w panelu (np. z telefonu): od razu potwierdzona, bez zaliczki.
 * o: { serviceId, date, time, duration?, resourceId?, outsideHours?, name, phone, email?, notes?, details? }
 */
async function createManualBooking(o, adminLogin) {
  try {
    return await tx(async (c) => {
      const svc = await av.loadService(c, "id = $1", o.serviceId);
      if (!svc || !svc.uses_slots) throw new HttpError(422, "Wybierz usługę z rezerwacją terminu.");
      const slot = await pickAdminSlot(c, svc, { ...o, duration: o.duration || av.durationFor(svc, o.details || {}) });
      return insertBooking(c, {
        serviceId: svc.id, resourceId: slot.resourceId, start: slot.start, end: slot.end, until: slot.until,
        status: "confirmed", name: o.name, phone: o.phone, email: o.email, details: o.details,
        notes: [o.notes, `Dodana w panelu przez ${adminLogin}`].filter(Boolean).join(" · "), consentAt: new Date(), source: "telefon",
      });
    });
  } catch (e) {
    if (e.code === "23P01") throw new HttpError(409, "Stanowisko jest w tym czasie zajęte – wybierz inną godzinę.");
    throw e;
  }
}

/**
 * Przełożenie potwierdzonej wizyty na inny termin (klient zadzwonił). Zaliczka i dane zostają,
 * a stary termin od razu wraca do puli. o: { date, time, duration?, resourceId?, outsideHours? }
 */
async function rescheduleBooking(id, o, adminLogin) {
  try {
    return await tx(async (c) => {
      const { rows: [b] } = await c.query("SELECT * FROM bookings WHERE id = $1 FOR UPDATE", [id]);
      if (!b) throw new HttpError(404, "Nie ma takiej rezerwacji.");
      if (b.status !== "confirmed" || !b.start_at) throw new HttpError(409, "Przełożyć można tylko potwierdzoną wizytę z terminem.");
      const svc = await av.loadService(c, "id = $1", b.service_id);
      const duration = o.duration || Math.round((b.end_at - b.start_at) / 60000);
      const slot = await pickAdminSlot(c, svc, { ...o, duration }, { excludeBooking: id, preferResource: b.resource_id });
      const was = `${av.localYmd(b.start_at)} ${av.localHm(b.start_at)}`;
      await c.query(
        `UPDATE bookings SET start_at = $2, end_at = $3, block_until = $4, resource_id = $5,
                notes = concat_ws(' · ', notes, $6::text) WHERE id = $1`,
        [id, slot.start, slot.end, slot.until, slot.resourceId, `Przełożona z ${was} przez ${adminLogin}`]);
      return { from: was };
    });
  } catch (e) {
    if (e.code === "23P01") throw new HttpError(409, "Stanowisko jest w tym czasie zajęte – wybierz inną godzinę.");
    throw e;
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

      const lapsed = booking.status === "expired" ||
        (booking.status === "pending_payment" && new Date(booking.hold_expires_at).getTime() <= Date.now());
      if (booking.status !== "pending_payment" && booking.status !== "expired") return { status: booking.status };   // np. anulowana

      let resourceId = booking.resource_id;
      if (lapsed && booking.start_at) {
        // płatność dotarła po wygaśnięciu holdu: potwierdzamy tylko, jeśli stanowisko (to albo inne) nadal jest wolne
        const svc = await av.loadService(c, "id = $1", booking.service_id);
        await lockResources(c, svc.resourceIds);
        const duration = Math.round((booking.end_at - booking.start_at) / 60000);
        const free = await av.resourcesFreeAt(c, svc, booking.start_at, duration, { excludeBooking: booking.id });
        if (!free.length) {
          console.warn("[płatność] zaliczka po wygaśnięciu holdu, termin zajęty – do zwrotu", booking.id);
          if (booking.status === "pending_payment") await c.query("UPDATE bookings SET status = 'expired' WHERE id = $1", [booking.id]);
          return { status: "expired", needsRefund: true };
        }
        resourceId = free.includes(resourceId) ? resourceId : free[0];
      }
      await c.query(
        "UPDATE bookings SET status = 'confirmed', confirmed_at = now(), hold_expires_at = NULL, resource_id = $2 WHERE id = $1",
        [booking.id, resourceId]);
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

/** Anulowanie przez admina. Termin wraca do puli (constraint i dostępność liczą tylko statusy aktywne). */
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

const LOCAL_COLS = (col) => `to_char(${col} AT TIME ZONE '${TZ}', 'YYYY-MM-DD')`;
const LOCAL_TIME = (col) => `to_char(${col} AT TIME ZONE '${TZ}', 'HH24:MI')`;

/** Status rezerwacji dla strony potwierdzenia (id rezerwacji = losowy UUID, pełni rolę tokenu). */
async function publicStatus(id) {
  const { rows: [r] } = await query(
    `SELECT b.id, ${EFFECTIVE_STATUS} AS status, b.hold_expires_at, b.customer_name, b.details, sv.name AS service_name, sv.slug, sv.uses_slots,
            ${LOCAL_COLS("b.start_at")} AS date, ${LOCAL_TIME("b.start_at")} AS time, ${LOCAL_TIME("b.end_at")} AS time_end,
            p.id AS payment_id, p.status AS payment_status, p.amount, p.provider
       FROM bookings b JOIN services sv ON sv.id = b.service_id
       LEFT JOIN payments p ON p.id = b.payment_id
      WHERE b.id = $1`, [id]);
  return r || null;
}

async function paymentInfo(paymentId) {
  const { rows: [r] } = await query(
    `SELECT p.id, CASE WHEN p.status = 'pending' AND ${EFFECTIVE_STATUS} = 'expired' THEN 'expired' ELSE p.status END AS status,
            p.amount, p.currency, p.provider, b.id AS booking_id, ${EFFECTIVE_STATUS} AS booking_status, b.hold_expires_at,
            sv.name AS service_name,
            ${LOCAL_COLS("b.start_at")} AS date, ${LOCAL_TIME("b.start_at")} AS time, ${LOCAL_TIME("b.end_at")} AS time_end
       FROM payments p JOIN bookings b ON b.id = p.booking_id JOIN services sv ON sv.id = b.service_id
      WHERE p.id = $1`, [paymentId]);
  return r || null;
}

module.exports = { createBooking, createManualBooking, rescheduleBooking, applyPaymentEvent, cancelBooking, listAvailable, listDays, expireHolds,
  publicStatus, paymentInfo, SLOT_TAKEN, EFFECTIVE_STATUS };
