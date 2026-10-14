/**
 * /api/platnosc/<op> (vercel.json przepisuje na /api/platnosc?op=<op>)
 *
 *  GET  status?id=<bookingId>   status rezerwacji dla strony /potwierdzenie (odpytywana, bo webhook może przyjść po powrocie klienta)
 *  GET  info?id=<paymentId>     dane płatności dla strony symulacji /platnosc/mock/<paymentId>
 *  POST mock                    „webhook” trybu mock: { paymentId, wynik: "zaplac" | "anuluj" } -> applyPaymentEvent()
 *  POST anuluj { id }           klient zrezygnował na stronie płatności – zamykamy sesję u dostawcy (Stripe wyśle checkout.session.expired)
 */
const { applyPaymentEvent, publicStatus, paymentInfo } = require("./_lib/bookings");
const { getProviderByName } = require("./_lib/payments");
const { getConfig } = require("./_lib/config");
const { query } = require("./_lib/db");
const { HttpError, readRaw, readBody, sendJson, getUrl, sameOrigin, handler } = require("./_lib/http");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const needId = (v) => { if (!UUID_RE.test(String(v || ""))) throw new HttpError(404, "Nie znaleziono."); return v; };

module.exports = handler(async (req, res) => {
  const url = getUrl(req);
  const op = url.searchParams.get("op") || url.pathname.split("/").pop();

  if (op === "status" && req.method === "GET") {
    const r = await publicStatus(needId(url.searchParams.get("id")));
    if (!r) throw new HttpError(404, "Nie znaleziono rezerwacji.");
    return sendJson(res, 200, { ok: true, rezerwacja: {
      status: r.status, usluga: r.service_name, data: r.date || (r.details && r.details.data) || null, godzina: r.time,
      pora: r.details && r.details.pora, kontakt: !r.uses_slots, imie: r.customer_name, slug: r.slug,
      holdDo: r.hold_expires_at, platnosc: r.payment_id ? { status: r.payment_status, kwota: r.amount, dostawca: r.provider } : null,
    } });
  }

  if (op === "info" && req.method === "GET") {
    const p = await paymentInfo(needId(url.searchParams.get("id")));
    if (!p || p.provider !== "mock") throw new HttpError(404, "Nie znaleziono płatności.");
    return sendJson(res, 200, { ok: true, platnosc: {
      status: p.status, kwota: p.amount, waluta: p.currency, rezerwacja: p.booking_id, statusRezerwacji: p.booking_status,
      usluga: p.service_name, data: p.date, godzina: p.time, holdDo: p.hold_expires_at,
    } });
  }

  if (req.method !== "POST") throw new HttpError(405, "Metoda niedozwolona.");
  if (!sameOrigin(req)) throw new HttpError(403, "Niedozwolone źródło.");

  if (op === "mock") {
    if (getConfig().paymentsMode !== "mock") throw new HttpError(404, "Symulacja płatności jest wyłączona.");
    const provider = getProviderByName("mock");
    const event = await provider.handleWebhook({ rawBody: await readRaw(req), headers: req.headers });
    // jak w Stripe: po wygaśnięciu sesji (= holdu) nie da się już zapłacić
    const info = await paymentInfo(event.paymentId);
    if (!info || info.provider !== "mock") throw new HttpError(404, "Nie znaleziono płatności.");
    const timedOut = info.status === "expired";
    if (event.type === "succeeded" && timedOut) event.type = "expired";
    const result = await applyPaymentEvent(event);
    const next = result.status === "confirmed" ? `/potwierdzenie?id=${info.booking_id}`
      : `/platnosc-nieudana?id=${info.booking_id}&powod=${timedOut ? "czas" : "anulowano"}`;
    return sendJson(res, 200, { ok: true, status: result.status, next });
  }

  if (op === "anuluj") {
    const body = await readBody(req);
    const id = needId(body.id);
    const { rows: [p] } = await query(
      `SELECT p.* FROM bookings b JOIN payments p ON p.id = b.payment_id
        WHERE b.id = $1 AND b.status = 'pending_payment' AND p.status = 'pending'`, [id]);
    if (p) {
      const provider = getProviderByName(p.provider);
      if (provider && provider.cancel) await provider.cancel(p);
    }
    return sendJson(res, 200, { ok: true });
  }

  throw new HttpError(404, "Nie znaleziono.");
});
