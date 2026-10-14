/**
 * GET /api/terminy?usluga=<slug>&dzien=YYYY-MM-DD[&pojazd=…&pakiet=…&dodatkowo=…]  – godziny w danym dniu
 * GET /api/terminy?usluga=<slug>&dni=1[&opcje…]                                    – kalendarz: wolne dni w całym horyzoncie
 * Wolne godziny startu w danym dniu (czas Europe/Warsaw). Opcje z formularza wpływają na czas wizyty,
 * więc lista pokazuje tylko te godziny, w których cała usługa się zmieści.
 */
const { listAvailable, listDays } = require("./_lib/bookings");
const { isRealDate, SERVICES } = require("./_lib/validate");
const { HttpError, sendJson, getUrl, handler } = require("./_lib/http");

module.exports = handler(async (req, res) => {
  if (req.method !== "GET") throw new HttpError(405, "Metoda niedozwolona.");
  const q = getUrl(req).searchParams;
  const slug = q.get("usluga") || "";
  const day = q.get("dzien") || "";
  if (!Object.prototype.hasOwnProperty.call(SERVICES, slug)) throw new HttpError(422, "Nieznana usługa.");
  const daysMode = q.get("dni") === "1";
  if (!daysMode && !isRealDate(day)) throw new HttpError(422, "Niepoprawna data.");

  // tylko opcje z listy formularza (reszta jest ignorowana)
  const details = {};
  for (const f of SERVICES[slug].fields) {
    if (!f.opts) continue;
    const vals = [...q.getAll(f.name), ...q.getAll(f.name + "[]")].filter((v) => f.opts.includes(v));
    if (vals.length) details[f.name] = f.type === "checks" ? vals : vals[0];
  }
  if (daysMode) {
    const d = await listDays(slug, details);
    return sendJson(res, 200, { ok: true, czas: d.duration, od: d.from, do: d.to,
      dni: Object.fromEntries(Object.entries(d.days).map(([k, v]) => [k, { wolne: v.n, pierwsza: v.first, zamkniete: v.closed }])) });
  }
  const r = await listAvailable(slug, day, details);
  sendJson(res, 200, { ok: true, dzien: day, czas: r.duration, zamkniete: r.closed || null,
    terminy: r.starts.map((s) => ({ godzina: s.time, do: s.end, start: s.start.toISOString(), wolne: s.resources.length })) });
});
