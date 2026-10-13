/**
 * Walidacja zgłoszenia z formularza. Schemat pól `details` dla każdej usługi pochodzi z
 * api/_uslugi.json (generowany przez src/build.py z tych samych definicji co formularze),
 * więc frontend i backend nie rozjadą się przy zmianie opcji.
 */
const SERVICES = require("../_uslugi.json");

const LIMITS = { imie: 60, telefon: 20, email: 100, marka: 80, rejestracja: 20, opis: 800, problem: 800 };

const clean = (v, max = 200) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** Polski numer: 9 cyfr, opcjonalnie z +48 / 48. Zwraca +48XXXXXXXXX albo null. */
function normalizePhone(v) {
  const d = String(v || "").replace(/[\s()-]/g, "");
  const m = /^(?:\+?48)?(\d{9})$/.exec(d);
  return m ? "+48" + m[1] : null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const isRealDate = (ymd) => YMD_RE.test(ymd) && new Date(ymd + "T12:00:00Z").toISOString().slice(0, 10) === ymd;

function validateDetails(schema, body, errors) {
  const details = {};
  for (const f of schema.fields) {
    const raw = body[f.name] !== undefined ? body[f.name] : body[f.name + "[]"];
    if (f.type === "chips" || f.type === "select") {
      const v = clean(Array.isArray(raw) ? raw[0] : raw, 120);
      if (!v) { if (f.req) errors.push(f.name); continue; }
      if (!f.opts.includes(v)) { errors.push(f.name); continue; }
      details[f.name] = v;
    } else if (f.type === "checks") {
      const arr = (Array.isArray(raw) ? raw : raw ? [raw] : []).slice(0, 10).map((x) => clean(x, 120));
      if (arr.some((x) => !f.opts.includes(x))) { errors.push(f.name); continue; }
      if (arr.length) details[f.name] = [...new Set(arr)];
      else if (f.req) errors.push(f.name);
    } else if (f.type === "date") {
      const v = clean(raw, 10);
      if (!v) { if (f.req) errors.push(f.name); continue; }
      if (!isRealDate(v)) { errors.push(f.name); continue; }
      details[f.name] = v;
    } else {
      const v = clean(raw, LIMITS[f.name] || 120);
      if (!v) { if (f.req) errors.push(f.name); continue; }
      details[f.name] = f.name === "rejestracja" ? v.toUpperCase() : v;
    }
  }
  return details;
}

/** Zwraca { errors: [nazwy pól], data } – data gotowe do zapisania (tylko pola z whitelisty). */
function validateBooking(body) {
  body = body || {};
  const errors = [];
  const slug = clean(body.usluga, 60);
  const schema = Object.prototype.hasOwnProperty.call(SERVICES, slug) ? SERVICES[slug] : null;
  if (!schema) return { errors: ["usluga"], data: null };

  const customerName = clean(body.imie, LIMITS.imie);
  if (customerName.length < 2) errors.push("imie");
  const phone = normalizePhone(body.telefon);
  if (!phone) errors.push("telefon");
  const email = clean(body.email, LIMITS.email);
  if (email && !EMAIL_RE.test(email)) errors.push("email");
  if (!(body.zgoda === true || body.zgoda === "tak" || body.zgoda === "true")) errors.push("zgoda");

  let date = null, time = null;
  if (schema.slots) {
    date = clean(body.data, 10);
    time = clean(body.godzina, 5);
    if (!isRealDate(date)) errors.push("data");
    if (!HM_RE.test(time)) errors.push("godzina");
  }
  const details = validateDetails(schema, body, errors);

  return { errors, data: { slug, schema, customerName, phone, email: email || null, details, date, time } };
}

module.exports = { validateBooking, normalizePhone, isRealDate, clean, SERVICES, YMD_RE, HM_RE };
