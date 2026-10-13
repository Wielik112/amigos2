/**
 * POST /api/stripe-webhook – zdarzenia Stripe (checkout.session.completed / expired / async_payment_*).
 * Podpis weryfikowany na surowym body (STRIPE_WEBHOOK_SECRET). Obsługa idempotentna (processed_events + stan płatności).
 */
const { applyPaymentEvent } = require("./_lib/bookings");
const { getProviderByName } = require("./_lib/payments");
const { HttpError, readRaw, sendJson, handler } = require("./_lib/http");

module.exports = handler(async (req, res) => {
  if (req.method !== "POST") throw new HttpError(405, "Metoda niedozwolona.");
  const provider = getProviderByName("stripe");
  if (!provider) throw new HttpError(404, "Płatności Stripe nie są skonfigurowane.");
  const event = await provider.handleWebhook({ rawBody: await readRaw(req), headers: req.headers });
  const result = await applyPaymentEvent(event);
  sendJson(res, 200, { received: true, ...result });
});
