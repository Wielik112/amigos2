/**
 * POST /api/zapis – przyjmuje rezerwacje z formularzy.
 *
 * Co robi:
 *  1. Sprawdza dane (whitelist pól, schemat pól usługi, telefon, zgoda, antyspam, limit na IP).
 *  2. W transakcji blokuje termin i tworzy rezerwację (api/_lib/bookings.js):
 *     - usługa z zaliczką -> status pending_payment, hold 15 min, odpowiedź z redirectUrl do płatności,
 *     - bez zaliczki      -> od razu confirmed (+ powiadomienie w panelu).
 *  3. Opcjonalnie (jak dotąd) wysyła e-mail przez Resend i JSON pod WEBHOOK_URL – błąd wysyłki nie psuje rezerwacji.
 *
 * Zmienne środowiskowe: zob. .env.example (DATABASE_URL, PAYMENTS_MODE, …) oraz dotychczasowe
 *  RESEND_API_KEY, BOOKING_TO, BOOKING_FROM, WEBHOOK_URL, WEBHOOK_SECRET.
 */
const SERVICES = require("./_uslugi.json");
const { validateBooking } = require("./_lib/validate");
const { createBooking } = require("./_lib/bookings");
const { isLimited } = require("./_lib/ratelimit");
const { HttpError, readBody, sendJson, redirect, getIp, sameOrigin, handler } = require("./_lib/http");

const LABELS = { pojazd: "Pojazd", badanie: "Badanie", pakiet: "Pakiet", zakres: "Zakres", dodatkowo: "Dodatkowo", sprawa: "Sprawa",
  ubezpieczenie: "Ubezpieczenie", polisa: "Polisa", data: "Data", godzina: "Godzina", pora: "Pora dnia", marka: "Marka i model",
  rejestracja: "Nr rejestracyjny", opis: "Opis", problem: "Opis problemu", imie: "Imię", telefon: "Telefon", email: "E-mail" };
const STATUS_LABEL = { confirmed: "potwierdzona", pending_payment: "czeka na zaliczkę" };

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function sendEmail(d, status) {
  const key = process.env.RESEND_API_KEY, to = process.env.BOOKING_TO;
  if (!key || !to) return false;
  const svc = SERVICES[d.usluga];
  const rows = Object.keys(LABELS).filter((k) => d[k] && (!Array.isArray(d[k]) || d[k].length))
    .map((k) => `<tr><td style="padding:6px 14px 6px 0;color:#53607a">${LABELS[k]}</td><td style="padding:6px 0;font-weight:700">${esc(Array.isArray(d[k]) ? d[k].join(", ") : d[k])}</td></tr>`).join("");
  const when = [d.data, d.godzina || d.pora].filter(Boolean).join(" ");
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#0e1a2e">
    <h2 style="margin:0 0 6px;color:#061a40">Nowa rezerwacja: ${esc(svc.name)}</h2>
    <p style="margin:0 0 16px;color:#53607a">Status: ${esc(STATUS_LABEL[status] || status)}. Szczegóły i aktualny status w panelu: /admin</p>
    <table style="border-collapse:collapse">${rows}</table></div>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: process.env.BOOKING_FROM || "Amigos – rezerwacje <onboarding@resend.dev>",
      to: to.split(",").map((s) => s.trim()),
      reply_to: d.email || undefined,
      subject: `${svc.name}: ${d.imie}, ${d.telefon}${when ? " – " + when : ""}`,
      html,
    }),
  });
  if (!res.ok) throw new Error("email " + res.status + " " + (await res.text()).slice(0, 200));
  return true;
}

async function sendWebhook(d, extra) {
  const url = process.env.WEBHOOK_URL;
  if (!url) return false;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Amigos-Secret": process.env.WEBHOOK_SECRET || "" },
    body: JSON.stringify({ ...d, ...extra, uslugaNazwa: SERVICES[d.usluga].name, utworzono: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error("webhook " + res.status);
  return true;
}

const FAIL_REDIRECT = { 409: "termin", 422: "dane", 429: "limit" };

module.exports = handler(async (req, res) => {
  const wantsJson = (req.headers["content-type"] || "").includes("application/json");
  const reply = (status, payload, location) => {
    if (!wantsJson && location) return redirect(res, location);
    return sendJson(res, status, payload);
  };

  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return reply(405, { ok: false, error: "Metoda niedozwolona." }); }
  if (!sameOrigin(req)) return reply(403, { ok: false, error: "Niedozwolone źródło." });

  const ip = getIp(req);
  if (await isLimited("zapis:" + ip, 5, 600)) return reply(429, { ok: false, error: "Za dużo zgłoszeń w krótkim czasie." }, "/rezerwacja?blad=limit");

  const body = await readBody(req);

  // antyspam: ukryte pole i zbyt szybkie wysłanie = bot -> udajemy sukces
  const age = Date.now() - Number(body.ts || 0);
  if (body.www || (body.ts && age < 2500)) return reply(200, { ok: true, status: "confirmed" }, "/dziekujemy");

  const { errors, data } = validateBooking(body);
  if (errors.length) return reply(422, { ok: false, error: "Sprawdź pola formularza.", fields: errors }, "/rezerwacja?blad=dane");

  let result;
  try {
    result = await createBooking(data);
  } catch (e) {
    if (e instanceof HttpError && !wantsJson && FAIL_REDIRECT[e.status]) return redirect(res, "/rezerwacja?blad=" + FAIL_REDIRECT[e.status]);
    throw e;
  }
  const { booking, status, redirectUrl } = result;
  console.log("[zapis] OK", data.slug, status, data.date || "", data.time || "");

  // dotychczasowe kanały (opcjonalne) – nie blokują odpowiedzi dłużej niż to konieczne i nie psują rezerwacji
  const flat = { usluga: data.slug, imie: data.customerName, telefon: data.phone, email: data.email || "",
    data: data.date || data.details.data || "", godzina: data.time || "", ...data.details };
  await Promise.allSettled([sendEmail(flat, status), sendWebhook(flat, { rezerwacjaId: booking.id, status })])
    .then((r) => r.forEach((x) => x.status === "rejected" && console.error("[zapis] błąd wysyłki", x.reason.message)));

  const done = `/potwierdzenie?id=${booking.id}`;
  return reply(200, { ok: true, status, bookingId: booking.id, redirectUrl: redirectUrl || null, confirmUrl: done }, redirectUrl || done);
});
