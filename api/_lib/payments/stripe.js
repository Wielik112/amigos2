/**
 * StripePaymentProvider – Stripe Checkout Session (PLN, BLIK + karta).
 * Rezerwację potwierdza WYŁĄCZNIE webhook (checkout.session.completed / async_payment_succeeded),
 * nigdy sam powrót klienta na success_url.
 */
const Stripe = require("stripe");
const { HttpError } = require("../http");

function create(cfg) {
  const stripe = new Stripe(cfg.stripeSecretKey);

  const eventFor = (event) => {
    const s = event.data && event.data.object ? event.data.object : {};
    const base = { provider: "stripe", eventId: event.id, providerRef: s.id, paymentId: (s.metadata || {}).paymentId };
    switch (event.type) {
      case "checkout.session.completed":
        // BLIK/karta zwykle od razu „paid”; przy płatnościach asynchronicznych czekamy na async_payment_succeeded
        return { ...base, type: s.payment_status === "paid" ? "succeeded" : "ignored" };
      case "checkout.session.async_payment_succeeded":
        return { ...base, type: "succeeded" };
      case "checkout.session.async_payment_failed":
        return { ...base, type: "failed" };
      case "checkout.session.expired":
        return { ...base, type: "expired" };
      default:
        return { ...base, type: "ignored" };
    }
  };

  return {
    name: "stripe",
    // Stripe nie pozwala ustawić expires_at sesji Checkout krócej niż 30 min od utworzenia,
    // więc w trybie real hold trwa co najmniej tyle – sesja i hold wygasają jednocześnie.
    minHoldMinutes: 30,
    client: stripe,

    async createPayment({ booking, payment, service, slot }) {
      const when = slot ? new Intl.DateTimeFormat("pl-PL", { timeZone: "Europe/Warsaw", dateStyle: "long", timeStyle: "short" }).format(slot.start_at) : null;
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        payment_method_types: ["blik", "card"],
        currency: "pln",
        locale: "pl",
        line_items: [{
          quantity: 1,
          price_data: {
            currency: "pln",
            unit_amount: payment.amount,     // kwota zawsze z bazy (services.deposit_amount)
            product_data: { name: `Zaliczka: ${service.name}`, ...(when ? { description: `Termin: ${when}` } : {}) },
          },
        }],
        metadata: { bookingId: booking.id, paymentId: payment.id },
        client_reference_id: booking.id,
        customer_email: booking.email || undefined,
        expires_at: Math.floor(new Date(booking.hold_expires_at).getTime() / 1000),
        success_url: `${cfg.publicBaseUrl}/potwierdzenie?id=${booking.id}`,
        cancel_url: `${cfg.publicBaseUrl}/platnosc-nieudana?id=${booking.id}&powod=anulowano`,
      }, { idempotencyKey: "checkout_" + payment.id });
      return { paymentId: payment.id, providerRef: session.id, redirectUrl: session.url };
    },

    async handleWebhook({ rawBody, headers }) {
      const sig = headers["stripe-signature"];
      if (!sig) throw new HttpError(400, "Brak podpisu Stripe.");
      let event;
      try {
        event = stripe.webhooks.constructEvent(rawBody, sig, cfg.stripeWebhookSecret);
      } catch (e) {
        // najczęściej: STRIPE_WEBHOOK_SECRET z innego endpointu / innego sandboxa niż ten, który wysyła zdarzenia
        console.error("[stripe-webhook] odrzucony podpis:", e.message, `(body: ${rawBody ? rawBody.length : 0} B)`);
        throw new HttpError(400, "Niepoprawny podpis webhooka.");
      }
      return eventFor(event);
    },

    /**
     * Zapasowe sprawdzenie u Stripe (gdy webhook nie dotarł): stan sesji pobrany z API kluczem tajnym.
     * Zwraca PaymentEvent albo null, gdy płatność wciąż trwa.
     */
    async fetchEvent(payment) {
      if (!payment.provider_ref) return null;
      const s = await stripe.checkout.sessions.retrieve(payment.provider_ref);
      const base = { provider: "stripe", eventId: null, paymentId: payment.id, providerRef: s.id };
      if (s.payment_status === "paid" || s.payment_status === "no_payment_required") return { ...base, type: "succeeded" };
      if (s.status === "expired") return { ...base, type: "expired" };
      return null;
    },

    async refund() {
      // Interfejs przewiduje zwroty; na tym etapie robi się je ręcznie w panelu Stripe.
      return { supported: false, refunded: false, message: "Zwrot zaliczki zrób ręcznie w panelu Stripe (Płatności → wybierz płatność → Zwróć)." };
    },

    async cancel(payment) {
      if (!payment.provider_ref) return;
      try { await stripe.checkout.sessions.expire(payment.provider_ref); } catch (e) { /* sesja mogła już wygasnąć */ }
    },
  };
}

module.exports = { create };
