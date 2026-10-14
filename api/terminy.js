/**
 * GET /api/terminy?usluga=<slug>&dzien=YYYY-MM-DD[&pojazd=…&pakiet=…&dodatkowo=…]
 * Wolne godziny startu w danym dniu (czas Europe/Warsaw). Opcje z formularza wpływają na czas wizyty,
 * więc lista pokazuje tylko te godziny, w których cała usługa się zmieści.
 */
const { listAvailable } = require("./_lib/bookings");
const { isRealDate, SERVICES } = require("./_lib/validate");
const { HttpError, sendJson, getUrl, handler } = require("./_lib/http");

module.exports = handler(async (req, res) => {
  if (req.method !== "GET") throw new HttpError(405, "Metoda niedozwolona.");
  const q = getUrl(req).searchParams;
  const slug = q.get("usluga") || "";
  const day = q.get("dzien") || "";
  if (!Object.prototype.hasOwnProperty.call(SERVICES, slug)) throw new HttpError(422, "Nieznana usługa.");
  if (!isRealDate(day)) throw new HttpError(422, "Niepoprawna data.");

  // tylko opcje z listy formularza (reszta jest ignorowana)
  const details = {};
  for (const f of SERVICES[slug].fields) {
    if (!f.opts) continue;
    const vals = [...q.getAll(f.name), ...q.getAll(f.name + "[]")].filter((v) => f.opts.includes(v));
    if (vals.length) details[f.name] = f.type === "checks" ? vals : vals[0];
  }
  const r = await listAvailable(slug, day, details);
  sendJson(res, 200, { ok: true, dzien: day, czas: r.duration, zamkniete: r.closed || null,
    terminy: r.starts.map((s) => ({ godzina: s.time, do: s.end, start: s.start.toISOString(), wolne: s.resources.length })) });
});
