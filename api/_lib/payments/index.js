/**
 * Abstrakcja płatności (zaliczka). Każdy dostawca implementuje:
 *
 *   name                                  'mock' | 'stripe'
 *   minHoldMinutes                        najkrótszy hold, jaki dostawca obsługuje (Stripe Checkout: 30 min)
 *   createPayment(ctx) -> { paymentId, providerRef, redirectUrl }
 *                                         ctx = { booking, payment, service, slot }
 *   handleWebhook(rawRequest) -> PaymentEvent
 *                                         rawRequest = { rawBody: Buffer, headers }; w trybie real weryfikuje podpis
 *   refund(payment) -> { supported, refunded, message }
 *   cancel(payment)                       opcjonalnie: zamyka niedokończoną płatność (np. wygasza sesję Stripe)
 *
 * PaymentEvent = { provider, eventId, type: 'succeeded'|'failed'|'expired'|'ignored', paymentId, providerRef }
 * Zdarzenie z każdego dostawcy trafia do tego samego bookings.applyPaymentEvent(), więc mock
 * przechodzi dokładnie tę samą logikę zmiany statusów co Stripe.
 *
 * Wybór dostawcy: PAYMENTS_MODE=mock | real (zob. config.js).
 */
const { getConfig } = require("../config");

const cache = new Map();

function getProviderByName(name) {
  const cfg = getConfig();
  const key = name === "stripe" ? `stripe:${cfg.stripeSecretKey}:${cfg.stripeWebhookSecret}` : "mock";
  if (cache.has(key)) return cache.get(key);
  let p;
  if (name === "stripe") {
    if (!cfg.stripeSecretKey || !cfg.stripeWebhookSecret) return null;
    p = require("./stripe").create(cfg);
  } else if (name === "mock") {
    p = require("./mock").create(cfg);
  } else {
    throw new Error("Nieznany dostawca płatności: " + name);
  }
  cache.set(key, p);
  return p;
}

/** Dostawca dla nowych płatności – wynika wyłącznie z PAYMENTS_MODE. */
function getProvider() {
  return getProviderByName(getConfig().paymentsMode === "real" ? "stripe" : "mock");
}

module.exports = { getProvider, getProviderByName };
