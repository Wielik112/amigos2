/**
 * POST /api/zapis – przyjmuje zgłoszenia z formularzy rezerwacji.
 *
 * Co robi:
 *  1. Sprawdza dane (whitelist pól, długości, telefon, zgoda, antyspam).
 *  2. Wysyła e-mail do firmy przez Resend (jeśli ustawisz zmienne środowiskowe).
 *  3. Opcjonalnie przekazuje zgłoszenie JSON-em pod WEBHOOK_URL
 *     (tu podłączysz panel / prawdziwy system rezerwacji z blokowaniem godzin).
 *
 * Zmienne środowiskowe (Vercel → Project → Settings → Environment Variables):
 *  RESEND_API_KEY   – klucz z resend.com (wysyłka e-maili)
 *  BOOKING_TO       – adres, na który mają przychodzić zgłoszenia, np. biuro@amigoscar.pl
 *  BOOKING_FROM     – nadawca, np. "Amigos – rezerwacje <rezerwacje@amigoscar.pl>"
 *                     (domena musi być zweryfikowana w Resend)
 *  WEBHOOK_URL      – (opcjonalnie) adres, pod który wysłać zgłoszenie jako JSON
 *  WEBHOOK_SECRET   – (opcjonalnie) wysyłany w nagłówku X-Amigos-Secret
 */
const SERVICES = require("./_uslugi.json");

const LIMITS = { imie: 60, telefon: 20, email: 100, marka: 80, rejestracja: 20, opis: 800, problem: 800, wiadomosc: 800 };
const ALLOWED = new Set(["usluga", "ts", "www", "imie", "telefon", "email", "zgoda", "data", "godzina", "pora",
  "pojazd", "badanie", "pakiet", "zakres", "dodatkowo", "sprawa", "ubezpieczenie", "polisa", "marka", "rejestracja", "opis", "problem"]);
const LABELS = { pojazd: "Pojazd", badanie: "Badanie", pakiet: "Pakiet", zakres: "Zakres", dodatkowo: "Dodatkowo", sprawa: "Sprawa",
  ubezpieczenie: "Ubezpieczenie", polisa: "Polisa", data: "Data", godzina: "Godzina", pora: "Pora dnia", marka: "Marka i model",
  rejestracja: "Nr rejestracyjny", opis: "Opis", problem: "Opis problemu", imie: "Imię", telefon: "Telefon", email: "E-mail" };

// prosty limit: 5 zgłoszeń / 10 min z jednego IP (na instancję funkcji)
const hits = new Map();
const limited = (ip) => {
  const t = Date.now(), win = 10 * 60 * 1000;
  const arr = (hits.get(ip) || []).filter((x) => t - x < win);
  arr.push(t);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > 5;
};

const clean = (v, max = 200) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function validate(body) {
  const errors = [];
  const d = {};
  for (const [k, v] of Object.entries(body || {})) {
    const key = k.replace(/\[\]$/, "");
    if (!ALLOWED.has(key)) continue;
    d[key] = Array.isArray(v) ? v.slice(0, 10).map((x) => clean(x, 80)) : clean(v, LIMITS[key] || 120);
  }
  if (!SERVICES[d.usluga]) errors.push("usluga");
  if (!d.imie || d.imie.length < 2) errors.push("imie");
  const tel = (d.telefon || "").replace(/[\s()-]/g, "");
  if (!/^(\+?48)?\d{9}$/.test(tel)) errors.push("telefon");
  if (d.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(d.email)) errors.push("email");
  if (!(body.zgoda === true || body.zgoda === "tak" || body.zgoda === "true")) errors.push("zgoda");
  if (d.data && !/^\d{4}-\d{2}-\d{2}$/.test(d.data)) errors.push("data");
  if (d.godzina && !/^\d{2}:\d{2}$/.test(d.godzina)) errors.push("godzina");
  return { d, errors };
}

async function sendEmail(d) {
  const key = process.env.RESEND_API_KEY, to = process.env.BOOKING_TO;
  if (!key || !to) return false;
  const svc = SERVICES[d.usluga];
  const rows = Object.keys(LABELS).filter((k) => d[k] && (!Array.isArray(d[k]) || d[k].length))
    .map((k) => `<tr><td style="padding:6px 14px 6px 0;color:#53607a">${LABELS[k]}</td><td style="padding:6px 0;font-weight:700">${esc(Array.isArray(d[k]) ? d[k].join(", ") : d[k])}</td></tr>`).join("");
  const when = [d.data, d.godzina || d.pora].filter(Boolean).join(" ");
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#0e1a2e">
    <h2 style="margin:0 0 6px;color:#061a40">Nowe zgłoszenie: ${esc(svc.name)}</h2>
    <p style="margin:0 0 16px;color:#53607a">Zadzwoń do klienta i potwierdź termin.</p>
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

async function sendWebhook(d) {
  const url = process.env.WEBHOOK_URL;
  if (!url) return false;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Amigos-Secret": process.env.WEBHOOK_SECRET || "" },
    body: JSON.stringify({ ...d, uslugaNazwa: SERVICES[d.usluga].name, utworzono: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error("webhook " + res.status);
  return true;
}

module.exports = async (req, res) => {
  const wantsJson = (req.headers["content-type"] || "").includes("application/json");
  const reply = (status, payload, redirect) => {
    res.setHeader("Cache-Control", "no-store");
    if (!wantsJson && redirect) { res.statusCode = 303; res.setHeader("Location", redirect); return res.end(); }
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(payload));
  };

  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return reply(405, { ok: false, error: "Metoda niedozwolona." }); }

  // tylko z naszej strony
  const origin = req.headers.origin;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  if (origin && host && new URL(origin).host !== host) return reply(403, { ok: false, error: "Niedozwolone źródło." });

  const ip = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "?";
  if (limited(ip)) return reply(429, { ok: false, error: "Za dużo zgłoszeń w krótkim czasie." }, "/rezerwacja?blad=limit");

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  // antyspam: ukryte pole i zbyt szybkie wysłanie = bot -> udajemy sukces
  const age = Date.now() - Number(body.ts || 0);
  if (body.www || (body.ts && age < 2500)) return reply(200, { ok: true }, "/dziekujemy");

  const { d, errors } = validate(body);
  if (errors.length) return reply(422, { ok: false, error: "Sprawdź pola formularza.", fields: errors }, "/rezerwacja?blad=dane");
  delete d.www; delete d.ts;

  try {
    const [mail, hook] = await Promise.all([sendEmail(d), sendWebhook(d)]);
    if (!mail && !hook) console.warn("[zapis] Brak RESEND_API_KEY/BOOKING_TO i WEBHOOK_URL – zgłoszenie tylko w logach:", JSON.stringify(d));
    else console.log("[zapis] OK", d.usluga, d.data || "", d.godzina || "");
    return reply(200, { ok: true }, "/dziekujemy");
  } catch (err) {
    console.error("[zapis] błąd wysyłki", err.message);
    return reply(502, { ok: false, error: "Nie udało się przekazać zgłoszenia." }, "/rezerwacja?blad=wysylka");
  }
};
