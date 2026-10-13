/**
 * GET /api/terminy?usluga=<slug>&dzien=YYYY-MM-DD – wolne terminy usługi w danym dniu (czas Europe/Warsaw).
 * Zwraca tylko sloty niezablokowane, w przyszłości i z wolnym miejscem (wygasłe holdy się nie liczą).
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
  const slots = await listAvailable(slug, day);
  sendJson(res, 200, { ok: true, dzien: day, terminy: slots.map((s) => ({ godzina: s.time, start: s.start, wolne: s.free })) });
});
