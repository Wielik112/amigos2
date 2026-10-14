/**
 * POST /api/stripe-webhook – zdarzenia Stripe (checkout.session.completed / expired / async_payment_*).
 * Podpis weryfikowany na surowym body (STRIPE_WEBHOOK_SECRET). Obsługa idempotentna (processed_events + stan płatności).
 *
 * GET /api/stripe-webhook – diagnostyka do otwarcia w przeglądarce (bez sekretów): tryb płatności, czy klucze są
 * ustawione, ile zdarzeń od Stripe dotarło i kiedy ostatnie.
 */
const { applyPaymentEvent } = require("./_lib/bookings");
const { getProviderByName } = require("./_lib/payments");
const { getConfig } = require("./_lib/config");
const { query } = require("./_lib/db");
const { HttpError, readRaw, sendJson, handler } = require("./_lib/http");

module.exports = handler(async (req, res) => {
  if (req.method === "GET") {
    const cfg = getConfig();
    const key = cfg.stripeSecretKey;
    const { rows: [e] } = await query("SELECT count(*)::int AS n, max(processed_at) AS last FROM processed_events WHERE provider = 'stripe'");
    return sendJson(res, 200, {
      ok: true,
      endpoint: "/api/stripe-webhook – ten adres wpisz w Stripe (Developers → Webhooks)",
      trybPlatnosci: cfg.paymentsMode,
      kluczStripe: !key ? "brak" : key.startsWith("sk_test_") || key.startsWith("rk_test_") ? "testowy (sandbox)" : "produkcyjny (live)",
      sekretWebhooka: cfg.stripeWebhookSecret ? "ustawiony" : "brak",
      zdarzeniaOdStripe: e.n,
      ostatnieZdarzenie: e.last,
    });
  }
  if (req.method !== "POST") throw new HttpError(405, "Metoda niedozwolona.");
  const provider = getProviderByName("stripe");
  if (!provider) throw new HttpError(404, "Płatności Stripe nie są skonfigurowane.");
  const event = await provider.handleWebhook({ rawBody: await readRaw(req), headers: req.headers });
  const result = await applyPaymentEvent(event);
  console.log("[stripe-webhook]", event.eventId, event.type, JSON.stringify(result));
  sendJson(res, 200, { received: true, ...result });
});
