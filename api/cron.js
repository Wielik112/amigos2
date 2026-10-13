/**
 * GET /api/cron – zadanie cykliczne: zwalnia terminy z wygasłymi holdami (Vercel Cron, zob. vercel.json).
 * Vercel wysyła nagłówek Authorization: Bearer <CRON_SECRET>. Dostępność i tak liczy tylko żywe holdy,
 * więc cron jest drugą warstwą (porządek w statusach), a nie warunkiem poprawności.
 */
const { expireHolds } = require("./_lib/bookings");
const { getConfig } = require("./_lib/config");
const { HttpError, sendJson, handler } = require("./_lib/http");

module.exports = handler(async (req, res) => {
  const { cronSecret } = getConfig();
  if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) throw new HttpError(401, "Brak dostępu.");
  const expired = await expireHolds(null);
  sendJson(res, 200, { ok: true, expired });
});
