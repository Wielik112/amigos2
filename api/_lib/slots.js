/**
 * Generator slotów. Godziny podawane są w czasie lokalnym (Europe/Warsaw); konwersję do UTC robi
 * Postgres (`timestamp AT TIME ZONE`), więc 08:00 to zawsze 08:00 w Polsce – także po zmianie czasu.
 */
const { query } = require("./db");
const { TZ } = require("./config");
const { HttpError } = require("./http");
const { isRealDate, HM_RE } = require("./validate");

const toMin = (hm) => { const [h, m] = hm.split(":").map(Number); return h * 60 + m; };

async function generateSlots(o, db = { query }) {
  const weekdays = [...new Set((o.weekdays || []).map(Number))].filter((d) => d >= 1 && d <= 7);   // 1 = pon … 7 = niedz
  const duration = Number(o.duration);
  const capacity = Number(o.capacity || 1);
  if (!isRealDate(o.from) || !isRealDate(o.to) || o.to < o.from) throw new HttpError(422, "Podaj poprawny zakres dat.");
  if ((Date.parse(o.to) - Date.parse(o.from)) / 86400000 > 366) throw new HttpError(422, "Zakres dat może mieć najwyżej rok.");
  if (!weekdays.length) throw new HttpError(422, "Wybierz co najmniej jeden dzień tygodnia.");
  if (!HM_RE.test(o.timeFrom || "") || !HM_RE.test(o.timeTo || "") || toMin(o.timeTo) <= toMin(o.timeFrom)) throw new HttpError(422, "Godzina „do” musi być późniejsza niż „od”.");
  if (!Number.isInteger(duration) || duration < 5 || duration > 480) throw new HttpError(422, "Długość slotu: od 5 do 480 minut.");
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 50) throw new HttpError(422, "Pojemność: od 1 do 50.");
  const span = toMin(o.timeTo) - toMin(o.timeFrom);
  if (span < duration) throw new HttpError(422, "Przedział godzin jest krótszy niż jeden slot.");

  const { rowCount } = await db.query(
    `INSERT INTO slots (service_id, start_at, end_at, capacity)
     SELECT $1, (d::date + $5::time + make_interval(mins => m))::timestamp AT TIME ZONE '${TZ}',
                (d::date + $5::time + make_interval(mins => m + $7::int))::timestamp AT TIME ZONE '${TZ}', $8::int
       FROM generate_series($2::date, $3::date, interval '1 day') d
      CROSS JOIN generate_series(0, $6::int - $7::int, $7::int) m
      WHERE extract(isodow FROM d)::int = ANY($4::int[])
        AND (d::date + $5::time + make_interval(mins => m))::timestamp AT TIME ZONE '${TZ}' > now()
     ON CONFLICT (service_id, start_at) DO NOTHING`,
    [o.serviceId, o.from, o.to, weekdays, o.timeFrom, span, duration, capacity]);
  return rowCount;
}

module.exports = { generateSlots };
