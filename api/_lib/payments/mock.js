/**
 * MockPaymentProvider – symulacja płatności bez kluczy.
 * redirectUrl prowadzi na /platnosc/mock/<paymentId>, gdzie klient klika „Zapłać (symulacja)” albo „Anuluj”.
 * Kliknięcie wysyła POST /api/platnosc/mock – handleWebhook() zamienia go na PaymentEvent,
 * a dalej działa ten sam applyPaymentEvent(), którego używa webhook Stripe.
 */
const crypto = require("crypto");
const { HttpError } = require("../http");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function create(cfg) {
  return {
    name: "mock",
    minHoldMinutes: 0,

    async createPayment({ payment }) {
      const providerRef = "mock_" + payment.id;
      return { paymentId: payment.id, providerRef, redirectUrl: `${cfg.publicBaseUrl}/platnosc/mock/${payment.id}` };
    },

    async handleWebhook({ rawBody }) {
      let body;
      try { body = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : String(rawBody || "")); } catch (e) { body = null; }
      if (!body || !UUID_RE.test(String(body.paymentId || ""))) throw new HttpError(400, "Niepoprawne żądanie płatności.");
      const type = body.wynik === "zaplac" ? "succeeded" : body.wynik === "anuluj" ? "expired" : null;
      if (!type) throw new HttpError(400, "Nieznany wynik płatności.");
      // „Anuluj” = odpowiednik checkout.session.expired w Stripe: płatność się nie odbyła, termin wraca do puli.
      return { provider: "mock", eventId: "mock_" + crypto.randomUUID(), type, paymentId: body.paymentId, providerRef: "mock_" + body.paymentId };
    },

    async refund() {
      return { supported: true, refunded: true, message: "Tryb testowy: płatność oznaczona jako zwrócona." };
    },

    async cancel() { /* w trybie mock nic nie trzeba zamykać u dostawcy */ },
  };
}

module.exports = { create };
